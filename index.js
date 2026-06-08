const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const fs = require('fs');
const pino = require('pino');
const http = require('http');
const qrcode = require('qrcode');

// ─── CONFIGURACIÓN ───────────────────────────────────────
const GEMINI_API_KEY = 'AIzaSyCVOOf1EVxT8VgeWxHzKV_S2r7UsMplnEM';
const TU_NUMERO = '573152707584';
const PORT = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// QR actual
let qrActual = null;
let botConectado = false;

// ─── SERVIDOR WEB PARA VER EL QR ─────────────────────────
const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (botConectado) {
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#0f0">
            <h1>✅ Bot Conectado</h1>
            <p>El bot está funcionando correctamente.</p>
        </body></html>`);
    } else if (qrActual) {
        const qrImage = await qrcode.toDataURL(qrActual);
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:20px;background:#111;color:white">
            <h1>📱 Escanea el QR con WhatsApp</h1>
            <p>Abre WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo</p>
            <img src="${qrImage}" style="width:300px;height:300px;border:5px solid #0f0;border-radius:10px"/>
            <p style="color:#888">La página se actualiza sola cada 10 segundos</p>
            <script>setTimeout(()=>location.reload(),10000)</script>
        </body></html>`);
    } else {
        res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:white">
            <h1>⏳ Iniciando bot...</h1>
            <p>Espera unos segundos y recarga la página</p>
            <script>setTimeout(()=>location.reload(),5000)</script>
        </body></html>`);
    }
});

server.listen(PORT, () => console.log(`Servidor QR en puerto ${PORT}`));

// ─── BASE DE DATOS ────────────────────────────────────────
function cargarJSON(archivo) {
    if (fs.existsSync(archivo)) {
        try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return []; }
    }
    return [];
}
function guardarJSON(archivo, datos) {
    fs.writeFileSync(archivo, JSON.stringify(datos, null, 2));
}

// ─── VARIABLES DE ESTADO ─────────────────────────────────
let estaDisponible = false;
let botActivo = true;
const historial = {};
const esperandoCita = {};
const esperandoAnuncio = {};

// ─── FUNCIONES ANTILINK ───────────────────────────────────
function tieneLink(texto) {
    return /(https?:\/\/|www\.|t\.me\/|bit\.ly\/|tinyurl|discord\.gg\/|wa\.me\/)/gi.test(texto);
}

async function esLinkSospechoso(texto) {
    try {
        const prompt = `Analiza este mensaje y responde SOLO con JSON sin markdown:
{"sospechoso": true o false, "razon": "motivo breve"}
Considera sospechoso: phishing, scams, links de Telegram desconocidos, acortadores raros, hackeo, cadenas de dinero, sorteos falsos.
NO es sospechoso: YouTube, Google, Wikipedia, Instagram, Twitter, Facebook normales.
Mensaje: "${texto}"`;
        const result = await model.generateContent(prompt);
        const respuesta = result.response.text().replace(/```json|```/g, '').trim();
        return JSON.parse(respuesta);
    } catch { return { sospechoso: false, razon: 'Error al analizar' }; }
}

// ─── FUNCIONES MODO SEGURO ────────────────────────────────
function guardarMensajePerdido(from, texto) {
    const mensajes = cargarJSON('mensajes_perdidos.json');
    mensajes.push({ de: from, mensaje: texto, hora: new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }) });
    guardarJSON('mensajes_perdidos.json', mensajes);
}

// ─── FUNCIONES DIFUSIÓN ───────────────────────────────────
function registrarContacto(chatId) {
    const contactos = cargarJSON('contactos.json');
    if (!contactos.find(c => c.numero === chatId)) {
        contactos.push({ numero: chatId, fechaRegistro: new Date().toISOString() });
        guardarJSON('contactos.json', contactos);
    }
}

// ─── IA CON GEMINI ────────────────────────────────────────
async function responderConIA(chatId, mensaje) {
    if (!historial[chatId]) historial[chatId] = [];
    historial[chatId].push({ role: 'user', parts: [{ text: mensaje }] });
    if (historial[chatId].length > 10) historial[chatId] = historial[chatId].slice(-10);
    try {
        const chat = model.startChat({
            history: historial[chatId].slice(0, -1),
            generationConfig: { maxOutputTokens: 500 },
            systemInstruction: 'Eres un asistente personal amigable. Cuando alguien quiera agendar una cita diles que escriban "cita". Si preguntan por disponibilidad diles que el profesional está ocupado pero pueden agendar una cita. Responde siempre en español, de forma breve y útil.'
        });
        const result = await chat.sendMessage(mensaje);
        const respuesta = result.response.text();
        historial[chatId].push({ role: 'model', parts: [{ text: respuesta }] });
        return respuesta;
    } catch (e) {
        return 'En este momento no puedo responder, intenta más tarde. 😊';
    }
}

// ─── AGENDAMIENTO ─────────────────────────────────────────
async function procesarAgendamiento(sock, from, texto) {
    if (!esperandoCita[from]) esperandoCita[from] = { paso: 0, datos: {} };
    const estado = esperandoCita[from];
    switch (estado.paso) {
        case 0: estado.paso = 1; return '¡Perfecto! Vamos a agendar tu cita 📅\n\n*¿Cuál es tu nombre completo?*';
        case 1: estado.datos.nombre = texto; estado.paso = 2; return `Gracias *${texto}* 😊\n\n*¿Para qué fecha quieres tu cita?*\nEscríbela así: AAAA-MM-DD\nEjemplo: 2026-05-20`;
        case 2:
            if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return '❌ Formato incorrecto. Escríbela así: *2026-05-20*';
            estado.datos.fecha = texto; estado.paso = 3; return '*¿A qué hora prefieres?*\nEscríbela así: HH:MM\nEjemplo: 10:30';
        case 3:
            if (!/^\d{2}:\d{2}$/.test(texto)) return '❌ Formato incorrecto. Escríbela así: *10:30*';
            estado.datos.hora = texto; estado.paso = 4; return '*¿Cuál es el motivo de tu cita?*';
        case 4:
            estado.datos.motivo = texto; estado.paso = 5;
            const d = estado.datos;
            return `📋 *Resumen de tu cita:*\n\n👤 Nombre: *${d.nombre}*\n📅 Fecha: *${d.fecha}*\n🕐 Hora: *${d.hora}*\n📝 Motivo: *${d.motivo}*\n\n¿Es correcto? Responde *SÍ* para confirmar o *NO* para cancelar`;
        case 5:
            if (texto.toLowerCase().includes('sí') || texto.toLowerCase() === 'si') {
                const citas = cargarJSON('citas.json');
                const nuevaCita = { id: Date.now(), numero: from, ...estado.datos, estado: 'pendiente', fechaAgendada: new Date().toISOString() };
                citas.push(nuevaCita);
                guardarJSON('citas.json', citas);
                delete esperandoCita[from];
                await sock.sendMessage(TU_NUMERO + '@s.whatsapp.net', { text: `🔔 *NUEVA CITA AGENDADA*\n\n👤 *${nuevaCita.nombre}*\n📅 Fecha: ${nuevaCita.fecha}\n🕐 Hora: ${nuevaCita.hora}\n📝 Motivo: ${nuevaCita.motivo}\n📱 Número: ${from}\n\nUsa *!confirmar ${citas.length}* para confirmarla` });
                return '✅ *¡Cita agendada exitosamente!*\n\nTe notificaremos cuando sea confirmada. ¡Hasta pronto! 😊';
            } else {
                delete esperandoCita[from];
                return '❌ Cita cancelada. Si cambias de opinión escribe *cita* cuando quieras. 😊';
            }
    }
}

// ─── COMANDOS ADMIN ───────────────────────────────────────
async function manejarComandoAdmin(sock, from, texto) {
    const cmd = texto.toLowerCase().trim();
    const citas = cargarJSON('citas.json');

    if (cmd === '!citas') {
        if (citas.length === 0) return '📅 No tienes citas agendadas.';
        citas.sort((a, b) => new Date(`${a.fecha} ${a.hora}`) - new Date(`${b.fecha} ${b.hora}`));
        let msg = `📋 *LISTA DE CITAS*\nTotal: ${citas.length}\n\n`;
        citas.forEach((c, i) => {
            const emoji = c.estado === 'confirmada' ? '✅' : c.estado === 'cancelada' ? '❌' : '⏳';
            msg += `${emoji} *${i + 1}. ${c.nombre}*\n📅 ${c.fecha} a las ${c.hora}\n📝 ${c.motivo}\n📱 ${c.numero}\n\n`;
        });
        return msg;
    }
    if (cmd === '!hoy') {
        const hoy = new Date().toISOString().split('T')[0];
        const citasHoy = citas.filter(c => c.fecha === hoy);
        if (citasHoy.length === 0) return '📅 No tienes citas hoy.';
        let msg = `📅 *CITAS DE HOY:*\n\n`;
        citasHoy.forEach((c, i) => { msg += `${i + 1}. 👤 *${c.nombre}* a las *${c.hora}*\n📝 ${c.motivo}\n\n`; });
        return msg;
    }
    if (cmd === '!disponible') { estaDisponible = true; return '✅ Modo *DISPONIBLE* activado.'; }
    if (cmd === '!ocupado') { estaDisponible = false; return '🔴 Modo *OCUPADO* activado.'; }
    if (cmd.startsWith('!confirmar ')) {
        const i = parseInt(cmd.split(' ')[1]) - 1;
        if (isNaN(i) || !citas[i]) return '❌ Número de cita inválido.';
        citas[i].estado = 'confirmada'; guardarJSON('citas.json', citas);
        await sock.sendMessage(citas[i].numero, { text: `✅ Hola *${citas[i].nombre}*! Tu cita ha sido *confirmada* para el *${citas[i].fecha}* a las *${citas[i].hora}*. ¡Te esperamos! 😊` });
        return `✅ Cita de *${citas[i].nombre}* confirmada.`;
    }
    if (cmd.startsWith('!cancelar ')) {
        const i = parseInt(cmd.split(' ')[1]) - 1;
        if (isNaN(i) || !citas[i]) return '❌ Número de cita inválido.';
        citas[i].estado = 'cancelada'; guardarJSON('citas.json', citas);
        await sock.sendMessage(citas[i].numero, { text: `Hola ${citas[i].nombre} 👋\nTu cita del *${citas[i].fecha}* a las *${citas[i].hora}* ha sido cancelada.\nContáctanos para reagendar. 🙏` });
        return `✅ Cita de *${citas[i].nombre}* cancelada.`;
    }
    if (cmd.startsWith('!permitir ')) {
        const numero = texto.split(' ')[1].replace(/[^0-9]/g, '');
        const lista = cargarJSON('lista_blanca.json');
        if (lista.includes(numero)) return '⚠️ Ya está en la lista blanca.';
        lista.push(numero); guardarJSON('lista_blanca.json', lista);
        return `✅ *${numero}* agregado a lista blanca antilink.`;
    }
    if (cmd.startsWith('!quitar ')) {
        const numero = texto.split(' ')[1].replace(/[^0-9]/g, '');
        guardarJSON('lista_blanca.json', cargarJSON('lista_blanca.json').filter(n => n !== numero));
        return `✅ *${numero}* eliminado de lista blanca.`;
    }
    if (cmd === '!listablanca') {
        const lista = cargarJSON('lista_blanca.json');
        if (lista.length === 0) return '📋 Lista blanca vacía.';
        return `📋 *LISTA BLANCA:*\n\n${lista.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
    }
    if (cmd === '!apagar') { botActivo = false; return '🔴 *MODO SEGURO ACTIVADO*\nBot apagado. Guardando mensajes entrantes.\nUsa *!encender* para volver.'; }
    if (cmd === '!encender') {
        botActivo = true;
        const perdidos = cargarJSON('mensajes_perdidos.json');
        let resumen = '✅ *BOT ENCENDIDO*\n\n';
        if (perdidos.length === 0) { resumen += 'No recibiste mensajes mientras estaba apagado.'; }
        else {
            resumen += `📬 *${perdidos.length} mensajes perdidos:*\n\n`;
            perdidos.forEach((m, i) => { resumen += `${i + 1}. 📱 ${m.de}\n🕐 ${m.hora}\n💬 "${m.mensaje.substring(0, 60)}"\n\n`; });
        }
        guardarJSON('mensajes_perdidos.json', []);
        return resumen;
    }
    if (cmd === '!anuncio') {
        const contactos = cargarJSON('contactos.json');
        const excluidos = cargarJSON('excluidos.json');
        esperandoAnuncio[from] = { paso: 1, excluirTemporales: [] };
        return `📢 *MODO ANUNCIO*\n\n👥 Contactos: *${contactos.length}*\n🚫 Excluidos: *${excluidos.length}*\n\nEscribe el mensaje a enviar o *!cancelaranuncio* para salir.`;
    }
    if (esperandoAnuncio[from]) {
        const estado = esperandoAnuncio[from];
        if (cmd === '!cancelaranuncio') { delete esperandoAnuncio[from]; return '❌ Anuncio cancelado.'; }
        if (estado.paso === 1) { estado.mensaje = texto; estado.paso = 2; return `✅ Mensaje guardado.\n\n*Vista previa:*\n${texto}\n\n¿Excluir a alguien? Escribe el número.\nO escribe *!enviar* para mandar a todos.`; }
        if (estado.paso === 2) {
            if (cmd === '!enviar') {
                const contactos = cargarJSON('contactos.json');
                const excluidos = [...cargarJSON('excluidos.json'), ...estado.excluirTemporales];
                const destinatarios = contactos.filter(c => !excluidos.includes(c.numero));
                delete esperandoAnuncio[from];
                let enviados = 0, fallidos = 0;
                for (const c of destinatarios) {
                    try { await sock.sendMessage(c.numero, { text: estado.mensaje }); enviados++; await new Promise(r => setTimeout(r, 2000)); } catch { fallidos++; }
                }
                return `📊 *ANUNCIO ENVIADO*\n✅ Enviados: *${enviados}*\n❌ Fallidos: *${fallidos}*`;
            }
            const num = texto.replace(/[^0-9]/g, '');
            estado.excluirTemporales.push(num);
            return `🚫 *${num}* excluido de este anuncio.\nExcluidos temporales: *${estado.excluirTemporales.length}*\nAgrega otro o escribe *!enviar*.`;
        }
    }
    if (cmd.startsWith('!excluir ')) {
        const numero = texto.split(' ')[1].replace(/[^0-9]/g, '');
        const excluidos = cargarJSON('excluidos.json');
        if (!excluidos.includes(numero)) { excluidos.push(numero); guardarJSON('excluidos.json', excluidos); }
        return `✅ *${numero}* excluido permanentemente de anuncios.`;
    }
    if (cmd.startsWith('!incluir ')) {
        const numero = texto.split(' ')[1].replace(/[^0-9]/g, '');
        guardarJSON('excluidos.json', cargarJSON('excluidos.json').filter(n => n !== numero));
        return `✅ *${numero}* puede recibir anuncios de nuevo.`;
    }
    if (cmd === '!contactos') {
        const contactos = cargarJSON('contactos.json');
        const excluidos = cargarJSON('excluidos.json');
        if (contactos.length === 0) return '📋 No hay contactos registrados.';
        let res = `👥 *CONTACTOS:* ${contactos.length} total\n\n`;
        contactos.forEach((c, i) => { res += `${excluidos.includes(c.numero) ? '🚫' : '✅'} ${i + 1}. ${c.numero}\n`; });
        return res;
    }
    if (cmd === '!stats') {
        const contactos = cargarJSON('contactos.json');
        return `📊 *ESTADÍSTICAS:*\n\n📅 Citas totales: *${citas.length}*\n✅ Confirmadas: *${citas.filter(c => c.estado === 'confirmada').length}*\n⏳ Pendientes: *${citas.filter(c => c.estado === 'pendiente').length}*\n❌ Canceladas: *${citas.filter(c => c.estado === 'cancelada').length}*\n👥 Contactos: *${contactos.length}*`;
    }
    if (cmd === '!limpiar') { historial[from] = []; return '🧹 Historial limpiado.'; }
    if (cmd === '!estado') {
        const lista = cargarJSON('lista_blanca.json');
        const perdidos = cargarJSON('mensajes_perdidos.json');
        return `📊 *ESTADO DEL BOT:*\n\n${botActivo ? '🟢 Encendido' : '🔴 Modo Seguro'}\n${estaDisponible ? '🟢 Disponible' : '🔴 Ocupado'}\n🛡️ Lista blanca: *${lista.length}* contactos\n📬 Mensajes guardados: *${perdidos.length}*`;
    }
    if (cmd === '!ayuda') {
        return `👑 *COMANDOS DE ADMIN:*\n\n📋 *!citas* — Ver todas las citas\n📅 *!hoy* — Citas de hoy\n✅ *!confirmar N* — Confirmar cita\n❌ *!cancelar N* — Cancelar cita\n🟢 *!disponible* — Activar disponibilidad\n🔴 *!ocupado* — Activar ocupado\n🛡️ *!permitir NUM* — Lista blanca antilink\n🚫 *!quitar NUM* — Quitar lista blanca\n📋 *!listablanca* — Ver lista blanca\n📢 *!anuncio* — Enviar anuncio masivo\n👥 *!contactos* — Ver contactos\n🔴 *!apagar* — Modo seguro ON\n🟢 *!encender* — Modo seguro OFF\n📊 *!stats* — Estadísticas\n📊 *!estado* — Estado del bot\n🧹 *!limpiar* — Limpiar historial IA`;
    }
    return null;
}

// ─── RECORDATORIOS ────────────────────────────────────────
function iniciarRecordatorios(sock) {
    cron.schedule('0 8 * * *', async () => {
        const hoy = new Date().toISOString().split('T')[0];
        const citasHoy = cargarJSON('citas.json').filter(c => c.fecha === hoy && c.estado === 'confirmada');
        if (citasHoy.length > 0) {
            let msg = `🔔 *Buenos días! Tienes ${citasHoy.length} cita(s) hoy:*\n\n`;
            citasHoy.forEach((c, i) => { msg += `${i + 1}. 👤 *${c.nombre}*\n🕐 ${c.hora}\n📝 ${c.motivo}\n\n`; });
            await sock.sendMessage(TU_NUMERO + '@s.whatsapp.net', { text: msg });
        }
    }, { timezone: 'America/Bogota' });
}

// ─── CONEXIÓN PRINCIPAL ───────────────────────────────────
async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Mi Asistente', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            qrActual = qr;
            botConectado = false;
            console.log('QR generado - abre la URL del servicio para escanearlo');
        }
        if (connection === 'close') {
            botConectado = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(conectar, 3000);
        } else if (connection === 'open') {
            botConectado = true;
            qrActual = null;
            console.log('✅ Bot conectado!');
            iniciarRecordatorios(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const from = msg.key.remoteJid;
            if (!from || from.includes('status')) continue;
            if (from.includes('@g.us')) continue;
            const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (!texto.trim()) continue;
            const esAdmin = from === TU_NUMERO + '@s.whatsapp.net';
            const enviar = async (respuesta) => { await sock.sendMessage(from, { text: respuesta }, { quoted: msg }); };

            if (esAdmin) {
                const respAdmin = await manejarComandoAdmin(sock, from, texto);
                if (respAdmin) { await enviar(respAdmin); continue; }
            }
            if (!esAdmin && tieneLink(texto)) {
                const listaBlanca = cargarJSON('lista_blanca.json');
                const numLimpio = from.replace('@s.whatsapp.net', '');
                if (!listaBlanca.includes(numLimpio)) {
                    const analisis = await esLinkSospechoso(texto);
                    if (analisis.sospechoso) {
                        await sock.sendMessage(TU_NUMERO + '@s.whatsapp.net', { text: `🚨 *ALERTA ROJA — ANTILINK*\n\n👤 Contacto: *${from}*\n🔗 Link: *${texto.substring(0, 100)}*\n⚠️ Razón: *${analisis.razon}*\n🕐 ${new Date().toLocaleString('es-CO')}\n🔒 *CONTACTO BLOQUEADO*` });
                        await enviar('🚫 Has sido bloqueado por enviar un link sospechoso.');
                        continue;
                    }
                }
            }
            if (!botActivo && !esAdmin) {
                guardarMensajePerdido(from, texto);
                await enviar('⏸️ En este momen
