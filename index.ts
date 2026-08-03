// Supabase Edge Function: telegram-webhook
// Recibe los mensajes del bot de Telegram y crea movimientos en la base de datos.
//
// Formato de mensaje esperado:
//   gasto 25.50 comida almuerzo con Juan
//   ingreso 1200 sueldo
//   /vincular ABC123
//
// Despliegue (desde el navegador, panel de Supabase -> Edge Functions -> New function,
// o con supabase CLI si prefieres terminal — ver README.md para ambas opciones).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Dhttps://igcobsrjflxtxugpowiv.supabase.co/rest/v1/;
const SERVICE_ROLE_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlnY29ic3JqZmx4dHh1Z3Bvd2l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3OTU0NDUsImV4cCI6MjEwMTM3MTQ0NX0.nq6TUoPR2If1XQu-48kxzgKBfrzni-H5jMwfcM2hnWA;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function responderTelegram(chatId: string | number, texto: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto }),
  });
}

Deno.serve(async (req) => {
  try {
    const update = await req.json();
    const msg = update.message;
    if (!msg || !msg.text) return new Response("ok");

    const chatId = msg.chat.id;
    const texto = msg.text.trim();

    // ---- Vincular cuenta ----
    if (texto.startsWith("/vincular")) {
      const codigo = texto.split(" ")[1]?.trim().toUpperCase();
      if (!codigo) {
        await responderTelegram(chatId, "Uso: /vincular CODIGO (lo encuentras en la app, sección Configuración).");
        return new Response("ok");
      }
      const { data: cfg, error } = await admin
        .from("configuracion")
        .select("user_id")
        .eq("telegram_token_vinculo", codigo)
        .maybeSingle();

      if (error || !cfg) {
        await responderTelegram(chatId, "Código inválido o vencido. Genera uno nuevo desde la app.");
        return new Response("ok");
      }
      await admin.from("configuracion").update({ telegram_chat_id: String(chatId) }).eq("user_id", cfg.user_id);
      await responderTelegram(chatId, "✅ Cuenta vinculada. Ya puedes registrar movimientos escribiendo, por ejemplo:\n\ngasto 25.50 comida almuerzo\ningreso 1200 sueldo");
      return new Response("ok");
    }

    // ---- Buscar usuario vinculado a este chat ----
    const { data: cfg } = await admin
      .from("configuracion")
      .select("*")
      .eq("telegram_chat_id", String(chatId))
      .maybeSingle();

    if (!cfg) {
      await responderTelegram(chatId, "Esta cuenta de Telegram no está vinculada todavía. Ve a la app, sección Configuración, copia el código y envía: /vincular CODIGO");
      return new Response("ok");
    }

    // ---- Parsear "tipo monto categoria descripcion..." ----
    const partes = texto.split(" ");
    const tipoTexto = partes[0]?.toLowerCase();
    const tipo = tipoTexto === "ingreso" ? "ingreso" : tipoTexto === "gasto" ? "gasto" : null;
    const monto = parseFloat(partes[1]);

    if (!tipo || isNaN(monto) || monto <= 0) {
      await responderTelegram(chatId, "No entendí el mensaje. Usa el formato:\n\ngasto MONTO categoria descripcion\ningreso MONTO categoria descripcion\n\nEjemplo: gasto 25.50 comida almuerzo");
      return new Response("ok");
    }

    const resto = partes.slice(2).join(" ").toLowerCase();

    // cuenta por defecto: la primera cuenta activa del usuario (se puede mejorar
    // permitiendo indicar la cuenta en el mensaje, ej: "gasto 25 comida | BCP")
    const { data: cuenta } = await admin
      .from("cuentas")
      .select("*")
      .eq("user_id", cfg.user_id)
      .eq("activo", true)
      .order("orden")
      .limit(1)
      .maybeSingle();

    if (!cuenta) {
      await responderTelegram(chatId, "No tienes ninguna cuenta activa configurada en la app.");
      return new Response("ok");
    }

    // buscar categoría por palabra clave dentro del texto restante
    const { data: cats } = await admin.from("categorias").select("*").eq("user_id", cfg.user_id).eq("tipo", tipo);
    let categoriaEncontrada = null;
    for (const cat of cats || []) {
      if ((cat.palabras_clave || []).some((k: string) => resto.includes(k))) {
        categoriaEncontrada = cat;
        break;
      }
    }

    const { error: insertError } = await admin.from("movimientos").insert({
      user_id: cfg.user_id,
      cuenta_id: cuenta.id,
      categoria_id: categoriaEncontrada?.id || null,
      tipo,
      monto,
      moneda: cuenta.moneda,
      descripcion: resto || null,
      fecha: new Date().toISOString().slice(0, 10),
      origen: "telegram",
    });

    if (insertError) {
      await responderTelegram(chatId, "Hubo un error guardando el movimiento. Intenta de nuevo.");
      return new Response("ok");
    }

    await responderTelegram(
      chatId,
      `✅ ${tipo === "ingreso" ? "Ingreso" : "Gasto"} registrado: ${cuenta.moneda} ${monto.toFixed(2)}` +
        (categoriaEncontrada ? ` — ${categoriaEncontrada.icono} ${categoriaEncontrada.nombre}` : "") +
        ` (${cuenta.nombre})`
    );
    return new Response("ok");
  } catch (e) {
    console.error(e);
    return new Response("ok"); // Telegram reintenta si no respondemos 200
  }
});
