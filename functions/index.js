/**
 * Bot de Telegram para agregar conceptos de gasto a Finanzas (Semana app)
 * sin abrir la app — útil cuando la conexión está mala.
 *
 * Cómo funciona:
 * 1. Telegram te manda tu mensaje a esta función (webhook).
 * 2. La función revisa que quien escribió esté en la lista de USUARIOS_PERMITIDOS.
 * 3. Interpreta el comando /gasto o /saldo.
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
const FORMAS_VALIDAS = ["efectivo", "cargo", "pago"];

// Alias: lo que TÚ escribes en Telegram → lo que se guarda en Firestore (lo que la app entiende).
// Agrega aquí más palabras si quieres poder escribir distinto.
const ALIAS_TIPO = {
  "fijo": "Fijos", "fijos": "Fijos",
  "variable": "Variables", "variables": "Variables",
  "ocio": "Ocio",
  "ahorro": "Ahorro"
};
const ALIAS_FORMA = {
  "efectivo": "efectivo",
  "gasto": "cargo", "cargo": "cargo",
  "pago": "pago"
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

async function enviarMensaje(chatId, texto) {
  console.log("TELEGRAM_TOKEN presente:", !!TELEGRAM_TOKEN, "longitud:", TELEGRAM_TOKEN ? TELEGRAM_TOKEN.length : 0);
  const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto })
  });
  const data = await resp.json().catch(() => ({}));
  console.log("Respuesta de Telegram:", resp.status, JSON.stringify(data));
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

async function buscarDeudaPorNombre(fzCode, nombre) {
  if (!nombre) return null;
  const snap = await db.collection("households").doc(fzCode).collection("fz_deudas").get();
  const match = snap.docs.find(d => (d.data().nombre || "").toLowerCase() === nombre.toLowerCase());
  return match ? { id: match.id, ...match.data() } : null;
}

async function manejarGasto(usuario, partes, chatId) {
  const [conceptoRaw, montoRaw, tipoRaw, formaPagoRaw, tarjetaRaw] = partes.map(p => (p || "").trim());

  if (!conceptoRaw || !montoRaw || !tipoRaw) {
    await enviarMensaje(chatId, "Formato: /gasto Concepto, Monto, Tipo, FormaPago (opcional), Tarjeta (opcional)\n\nEj: /gasto Transporte, 400, Fijos");
    return;
  }
  const monto = parseFloat(montoRaw.replace(/[^0-9.]/g, ""));
  if (isNaN(monto) || monto <= 0) {
    await enviarMensaje(chatId, "❌ El monto no es válido. Ejemplo correcto: /gasto Transporte, 400, Fijos");
    return;
  }
  const tipo = ALIAS_TIPO[tipoRaw.toLowerCase()];
  if (!tipo) {
    await enviarMensaje(chatId, `❌ Tipo inválido. Usa uno de: ${Object.keys(ALIAS_TIPO).join(", ")}`);
    return;
  }
  let formaPago = "efectivo";
  if (formaPagoRaw) {
    const fp = ALIAS_FORMA[formaPagoRaw.toLowerCase()];
    if (!fp) {
      await enviarMensaje(chatId, `❌ Forma de pago inválida. Usa: ${Object.keys(ALIAS_FORMA).join(", ")}`);
      return;
    }
    formaPago = fp;
  }

  let tarjetaId = null;
  let tarjetaNombre = null;
  if (formaPago !== "efectivo") {
    if (!tarjetaRaw) {
      await enviarMensaje(chatId, "❌ Si es cargo o pago necesitas indicar la tarjeta. Ej: /gasto Telcel, 549, Fijos, cargo, Banamex");
      return;
    }
    const deuda = await buscarDeudaPorNombre(usuario.fzCode, tarjetaRaw);
    if (!deuda) {
      await enviarMensaje(chatId, `❌ No encontré una tarjeta/deuda llamada "${tarjetaRaw}" en tu app. Revisa el nombre exacto.`);
      return;
    }
    tarjetaId = deuda.id;
    tarjetaNombre = deuda.nombre;
  }

  const periodo = await obtenerPeriodoActual(usuario.fzCode, usuario.vista);
  if (!periodo) {
    await enviarMensaje(chatId, `❌ No encontré ninguna ${usuario.vista === "semanal" ? "semana" : "quincena"} activa. Crea una primero desde la app.`);
    return;
  }

  const nuevoGasto = {
    id: uid(),
    tipo,
    concepto: conceptoRaw,
    presupuestado: monto,
    gastado: monto,
    acumulador: false,
    miniConceptos: [],
    formaPago,
    tarjetaId,
    montoCapital: null,
    metaAhorroId: null,
    pagado: true
  };

  await db.collection("households").doc(usuario.fzCode).collection("fz_quincenas").doc(periodo.id)
    .update({ gastos: admin.firestore.FieldValue.arrayUnion(nuevoGasto) });

  const detalle = formaPago === "efectivo"
    ? "Efectivo"
    : `${formaPago === "cargo" ? "Cargo" : "Pago"} → ${tarjetaNombre}`;
  await enviarMensaje(chatId, `✅ Agregado a "${periodo.label || periodo.fechaInicio}": ${conceptoRaw} — ${money(monto)} (${tipo}, ${detalle})`);
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
      const partes = resto.split(",");
      await manejarGasto(usuario, partes, chatId);
    } else if (texto.startsWith("/saldo")) {
      await manejarSaldo(usuario, chatId);
    } else if (texto.startsWith("/start")) {
      await enviarMensaje(chatId, `Hola ${usuario.nombre} 👋\n\nComandos disponibles:\n/gasto Concepto, Monto, Tipo, FormaPago, Tarjeta\n/saldo`);
    } else {
      await enviarMensaje(chatId, "No reconozco ese comando. Usa /gasto o /saldo.");
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(200).send("ok"); // siempre 200 para que Telegram no reintente en bucle
  }
});
