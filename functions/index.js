/**
 * Bot de Telegram para agregar conceptos de gasto a Finanzas (Semana app)
 * sin abrir la app — útil cuando la conexión está mala.
 *
 * Cómo funciona:
 * 1. Telegram te manda tu mensaje a esta función (webhook).
 * 2. La función revisa que quien escribió esté en la lista de USUARIOS_PERMITIDOS.
 * 3. Interpreta el comando /gasto, /pago o /saldo.
 * 4. Escribe directo en tu Firestore, en el período (quincena o semana) más reciente
 *    que le corresponda a esa persona.
 * 5. Responde por Telegram confirmando.
 *
 * No usa IA — el formato es fijo, así que es 100% gratis para siempre
 * (dentro de la capa gratuita de Firebase Functions + Telegram, que no cobra nada).
 */

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

// ⚠️ PASO OBLIGATORIO: reemplaza estos valores con los tuyos reales.
// - telegramId: lo obtienes hablándole a @userinfobot en Telegram (te dice tu ID numérico).
// - fzCode: el código de sincronización de Finanzas que ya usas en la app (el tuyo, no el de Negocios).
// - vista: 'quincenal' o 'semanal', según qué vista usa cada quien en la app.
const USUARIOS_PERMITIDOS = {
  "8372031942": { nombre: "Carlos", fzCode: "G003OP", vista: "quincenal" },
  "8002328997": { nombre: "Monse", fzCode: "NCN4C1", vista: "semanal" }
};

// El token te lo da @BotFather al crear el bot. NO lo pongas aquí directo en producción real,
// pero para este proyecto personal es suficiente con dejarlo como variable de entorno (ver guía).
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Valores REALES que espera la app (no los cambies — así están escritos en finanzas.html).
const TIPOS_VALIDOS = ["Fijos", "Variables", "Ocio", "Ahorro"];

// Las 4 categorías fijas de la pantalla "Tarjetas y deudas" (deben coincidir con CATEGORIA_DEUDA en finanzas.html).
const CATEGORIA_DEUDA = [
  { key: "tarjeta", label: "Tarjetas" },
  { key: "deuda", label: "Deudas" },
  { key: "automotriz", label: "Automotriz" },
  { key: "hipotecario", label: "Hipotecario" }
];
const CATEGORIA_LABEL = Object.fromEntries(CATEGORIA_DEUDA.map(c => [c.key, c.label]));

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

async function enviarMensaje(chatId, texto) {
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto })
  });
  const data = await resp.json().catch(() => ({}));
  console.log("Respuesta de Telegram (sendMessage):", resp.status, JSON.stringify(data));
}

// Igual que enviarMensaje pero con botones inline. `botones` es un arreglo plano;
// cada botón ocupa su propio renglón (más fácil de tocar en el celular).
async function enviarBotones(chatId, texto, botones) {
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      reply_markup: { inline_keyboard: botones.map(b => [b]) }
    })
  });
  const data = await resp.json().catch(() => ({}));
  console.log("Respuesta de Telegram (botones):", resp.status, JSON.stringify(data));
}

// Le avisa a Telegram que ya recibimos el toque del botón (si no, el botón se queda "cargando").
async function responderCallback(callbackQueryId, texto) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: texto || "" })
  }).catch(err => console.error("Error en answerCallbackQuery:", err));
}

function money(n) {
  return "$" + Number(n).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Encuentra el período (quincena o semana) más reciente de esa vista, dentro del código del usuario
async function obtenerPeriodoActual(fzCode, vista) {
  const snap = await db.collection("households").doc(fzCode).collection("fz_quincenas").get();
  const periodos = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => (p.tipoPeriodo || "quincenal") === vista)
    .sort((a, b) => (a.fechaInicio || "").localeCompare(b.fechaInicio || ""));
  return periodos.length ? periodos[periodos.length - 1] : null;
}

async function listarDeudasPorCategoria(fzCode, categoriaKey) {
  const snap = await db.collection("households").doc(fzCode).collection("fz_deudas").get();
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(d => (d.tipo || "tarjeta") === categoriaKey);
}

// Guarda un gasto (o pago) en el período actual del usuario. Centraliza lo que antes
// estaba repetido entre /gasto y /pago.
async function insertarGasto(usuario, nuevoGasto, chatId, mensajeExito) {
  const periodo = await obtenerPeriodoActual(usuario.fzCode, usuario.vista);
  if (!periodo) {
    await enviarMensaje(chatId, `❌ No encontré ninguna ${usuario.vista === "semanal" ? "semana" : "quincena"} activa. Crea una primero desde la app.`);
    return;
  }
  await db.collection("households").doc(usuario.fzCode).collection("fz_quincenas").doc(periodo.id)
    .update({ gastos: admin.firestore.FieldValue.arrayUnion(nuevoGasto) });
  await enviarMensaje(chatId, mensajeExito(periodo));
}

// Estado intermedio de un /gasto en construcción, mientras el usuario va tocando botones.
// Telegram no manda contexto entre mensajes, así que lo guardamos nosotros por chat.
function pendienteRef(chatId) {
  return db.collection("bot_pendientes").doc(String(chatId));
}

// --- /gasto: paso 1, el usuario escribe "Concepto, Monto" ---
async function manejarGastoInicio(usuario, resto, chatId) {
  const [conceptoRaw, montoRaw] = resto.split(",").map(p => (p || "").trim());
  if (!conceptoRaw || !montoRaw) {
    await enviarMensaje(chatId, "Formato: /gasto Concepto, Monto\n\nEj: /gasto Uber, 150\n\nDespués te pregunto tipo, forma de pago y tarjeta con botones.");
    return;
  }
  const monto = parseFloat(montoRaw.replace(/[^0-9.]/g, ""));
  if (isNaN(monto) || monto <= 0) {
    await enviarMensaje(chatId, "❌ El monto no es válido. Ejemplo: /gasto Uber, 150");
    return;
  }
  await pendienteRef(chatId).set({ concepto: conceptoRaw, monto });
  const botones = TIPOS_VALIDOS.map(t => ({ text: t, callback_data: `gtipo|${t}` }));
  await enviarBotones(chatId, `"${conceptoRaw}" — ${money(monto)}\n\n¿Qué tipo de gasto es?`, botones);
}

// --- /gasto: paso 2, tocó el tipo ---
async function manejarGastoTipo(usuario, tipo, chatId) {
  const snap = await pendienteRef(chatId).get();
  if (!snap.exists) {
    await enviarMensaje(chatId, "❌ Se perdió el contexto (¿tardaste mucho?). Empieza de nuevo con /gasto.");
    return;
  }
  await pendienteRef(chatId).update({ tipo });
  const botones = [
    { text: "Efectivo", callback_data: "gforma|efectivo" },
    { text: "Cargo a tarjeta", callback_data: "gforma|cargo" }
  ];
  await enviarBotones(chatId, "¿Cómo lo pagaste?", botones);
}

// --- /gasto: paso 3, tocó forma de pago (si es Efectivo, aquí mismo se guarda el gasto) ---
async function manejarGastoForma(usuario, forma, chatId) {
  const snap = await pendienteRef(chatId).get();
  if (!snap.exists) {
    await enviarMensaje(chatId, "❌ Se perdió el contexto. Empieza de nuevo con /gasto.");
    return;
  }
  const pend = snap.data();
  if (forma === "efectivo") {
    await finalizarGasto(usuario, { ...pend, formaPago: "efectivo", tarjetaId: null }, chatId, null);
    await pendienteRef(chatId).delete();
    return;
  }
  await pendienteRef(chatId).update({ formaPago: "cargo" });
  const botones = CATEGORIA_DEUDA.map(c => ({ text: c.label, callback_data: `gcat|${c.key}` }));
  await enviarBotones(chatId, "¿A qué categoría de tarjeta se carga?", botones);
}

// --- /gasto: paso 4, tocó la categoría (si solo hay 1 tarjeta ahí, se guarda directo) ---
async function manejarGastoCategoria(usuario, categoriaKey, chatId) {
  const snap = await pendienteRef(chatId).get();
  if (!snap.exists) {
    await enviarMensaje(chatId, "❌ Se perdió el contexto. Empieza de nuevo con /gasto.");
    return;
  }
  const pend = snap.data();
  const items = await listarDeudasPorCategoria(usuario.fzCode, categoriaKey);
  if (items.length === 0) {
    await enviarMensaje(chatId, `❌ No tienes ninguna tarjeta/deuda en "${CATEGORIA_LABEL[categoriaKey]}".`);
    return;
  }
  if (items.length === 1) {
    await finalizarGasto(usuario, { ...pend, tarjetaId: items[0].id }, chatId, items[0].nombre);
    await pendienteRef(chatId).delete();
    return;
  }
  const botones = items.map(d => ({ text: d.nombre, callback_data: `gdeuda|${d.id}` }));
  await enviarBotones(chatId, "¿A cuál tarjeta?", botones);
}

// --- /gasto: paso 5 (solo si había más de una tarjeta en la categoría) ---
async function manejarGastoDeuda(usuario, deudaId, chatId) {
  const snap = await pendienteRef(chatId).get();
  if (!snap.exists) {
    await enviarMensaje(chatId, "❌ Se perdió el contexto. Empieza de nuevo con /gasto.");
    return;
  }
  const pend = snap.data();
  const dSnap = await db.collection("households").doc(usuario.fzCode).collection("fz_deudas").doc(deudaId).get();
  const nombre = dSnap.exists ? dSnap.data().nombre : "?";
  await finalizarGasto(usuario, { ...pend, tarjetaId: deudaId }, chatId, nombre);
  await pendienteRef(chatId).delete();
}

// --- /gasto: registro final, ya con tipo + forma de pago + (si aplica) tarjeta resueltos ---
async function finalizarGasto(usuario, pend, chatId, tarjetaNombre) {
  const nuevoGasto = {
    id: uid(),
    tipo: pend.tipo,
    concepto: pend.concepto,
    presupuestado: pend.monto,
    gastado: pend.monto,
    acumulador: false,
    miniConceptos: [],
    formaPago: pend.formaPago,
    tarjetaId: pend.tarjetaId || null,
    montoCapital: null,
    metaAhorroId: null,
    pagado: true
  };
  const detalle = pend.formaPago === "efectivo" ? "Efectivo" : `Cargo → ${tarjetaNombre}`;
  await insertarGasto(usuario, nuevoGasto, chatId, (periodo) =>
    `✅ Agregado a "${periodo.label || periodo.fechaInicio}": ${pend.concepto} — ${money(pend.monto)} (${pend.tipo}, ${detalle})`);
}

// --- /pago: paso 1, el usuario escribe el monto ---
async function manejarPago(usuario, resto, chatId) {
  const monto = parseFloat(resto.replace(/[^0-9.]/g, ""));
  if (isNaN(monto) || monto <= 0) {
    await enviarMensaje(chatId, "Formato: /pago Monto\n\nEj: /pago 1500\n\nDespués te pregunto a cuál tarjeta/deuda aplica.");
    return;
  }
  const botones = CATEGORIA_DEUDA.map(cat => ({
    text: cat.label,
    callback_data: `pagocat|${monto}|${cat.key}`
  }));
  await enviarBotones(chatId, `¿A qué categoría aplica el pago de ${money(monto)}?`, botones);
}

// --- /pago: paso 2, el usuario tocó una categoría ---
async function manejarPagoCategoria(usuario, monto, categoriaKey, chatId) {
  const items = await listarDeudasPorCategoria(usuario.fzCode, categoriaKey);
  const label = CATEGORIA_LABEL[categoriaKey] || categoriaKey;

  if (items.length === 0) {
    await enviarMensaje(chatId, `❌ No tienes ninguna deuda registrada en "${label}" todavía.`);
    return;
  }
  if (items.length === 1) {
    await registrarPago(usuario, monto, items[0], chatId);
    return;
  }
  const botones = items.map(d => ({
    text: d.nombre,
    callback_data: `pagodeuda|${monto}|${d.id}`
  }));
  await enviarBotones(chatId, `¿A cuál de ${label.toLowerCase()} aplicamos el pago de ${money(monto)}?`, botones);
}

// --- /pago: paso 3 (solo si había más de una deuda en la categoría) ---
async function manejarPagoDeuda(usuario, monto, deudaId, chatId) {
  const snap = await db.collection("households").doc(usuario.fzCode).collection("fz_deudas").doc(deudaId).get();
  if (!snap.exists) {
    await enviarMensaje(chatId, "❌ Esa tarjeta/deuda ya no existe. Intenta de nuevo con /pago.");
    return;
  }
  await registrarPago(usuario, monto, { id: snap.id, ...snap.data() }, chatId);
}

// --- /pago: registro final, ya con la deuda resuelta ---
async function registrarPago(usuario, monto, deuda, chatId) {
  const nuevoGasto = {
    id: uid(),
    tipo: "Fijos",
    concepto: `Pago ${deuda.nombre}`,
    presupuestado: monto,
    gastado: monto,
    acumulador: false,
    miniConceptos: [],
    formaPago: "pago",
    tarjetaId: deuda.id,
    montoCapital: null,
    metaAhorroId: null,
    pagado: true
  };
  await insertarGasto(usuario, nuevoGasto, chatId, (periodo) =>
    `✅ Pago registrado en "${periodo.label || periodo.fechaInicio}": ${money(monto)} → ${deuda.nombre}\n(No cuenta en tu T. Gastos, solo baja el saldo de la deuda.)`);
}

async function manejarSaldo(usuario, chatId) {
  const periodo = await obtenerPeriodoActual(usuario.fzCode, usuario.vista);
  if (!periodo) {
    await enviarMensaje(chatId, "❌ No encontré ningún período activo.");
    return;
  }
  const gastos = periodo.gastos || [];
  const gastosReales = gastos.filter(g => g.formaPago !== "pago");
  const totalGastado = gastosReales.reduce((s, g) => s + (Number(g.gastado) || 0), 0);
  const ingresoExtra = (periodo.ingresosExtra || []).reduce((s, i) => s + (Number(i.monto) || 0), 0);
  const meQueda = (Number(periodo.ingresos) || 0) + ingresoExtra - totalGastado;
  await enviarMensaje(chatId, `💰 ${periodo.label || periodo.fechaInicio}\nMe queda: ${money(meQueda)}\nTotal gastado: ${money(totalGastado)}`);
}

exports.telegramWebhook = onRequest({ secrets: ["TELEGRAM_BOT_TOKEN"] }, async (req, res) => {
  try {
    const update = req.body;

    // --- Toques de botones (inline keyboard) ---
    const callback = update.callback_query;
    if (callback) {
      const telegramId = String(callback.from.id);
      const chatId = callback.message.chat.id;
      const usuario = USUARIOS_PERMITIDOS[telegramId];
      await responderCallback(callback.id);

      if (!usuario) { res.status(200).send("ok"); return; }

      const partes = (callback.data || "").split("|");
      if (partes[0] === "pagocat") {
        await manejarPagoCategoria(usuario, parseFloat(partes[1]), partes[2], chatId);
      } else if (partes[0] === "pagodeuda") {
        await manejarPagoDeuda(usuario, parseFloat(partes[1]), partes[2], chatId);
      } else if (partes[0] === "gtipo") {
        await manejarGastoTipo(usuario, partes[1], chatId);
      } else if (partes[0] === "gforma") {
        await manejarGastoForma(usuario, partes[1], chatId);
      } else if (partes[0] === "gcat") {
        await manejarGastoCategoria(usuario, partes[1], chatId);
      } else if (partes[0] === "gdeuda") {
        await manejarGastoDeuda(usuario, partes[1], chatId);
      }
      res.status(200).send("ok");
      return;
    }

    // --- Mensajes de texto normales ---
    const message = update.message;
    if (!message || !message.text) { res.status(200).send("ok"); return; }

    const telegramId = String(message.from.id);
    const chatId = message.chat.id;
    const usuario = USUARIOS_PERMITIDOS[telegramId];

    if (!usuario) {
      // MODO DEBUG TEMPORAL — luego lo regresamos a silencioso.
      await enviarMensaje(chatId, `⚠️ Tu ID de Telegram es: ${telegramId}\nNo está en la lista de USUARIOS_PERMITIDOS todavía.`);
      res.status(200).send("ok");
      return;
    }

    const texto = message.text.trim();

    if (texto.startsWith("/gasto")) {
      const resto = texto.replace(/^\/gasto/, "").trim();
      await manejarGastoInicio(usuario, resto, chatId);
    } else if (texto.startsWith("/pago")) {
      const resto = texto.replace(/^\/pago/, "").trim();
      await manejarPago(usuario, resto, chatId);
    } else if (texto.startsWith("/saldo")) {
      await manejarSaldo(usuario, chatId);
    } else if (texto.startsWith("/start")) {
      await enviarMensaje(chatId, `Hola ${usuario.nombre} 👋\n\nComandos disponibles:\n/gasto Concepto, Monto (te pregunto tipo, forma de pago y tarjeta con botones)\n/pago Monto (te muestro botones para elegir la deuda)\n/saldo`);
    } else {
      await enviarMensaje(chatId, "No reconozco ese comando. Usa /gasto, /pago o /saldo.");
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(200).send("ok"); // siempre 200 para que Telegram no reintente en bucle
  }
});
