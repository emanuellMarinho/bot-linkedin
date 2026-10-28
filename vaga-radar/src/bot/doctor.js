// Local dependency smoke check, including modules loaded lazily by the portable
// executable. It never opens a WhatsApp connection or submits an application.
export async function runDoctor({ output = console.log } = {}) {
  const modules = ["@whiskeysockets/baileys", "qrcode-terminal", "playwright-core", "pdfkit", "better-sqlite3", "../messaging/sms.js", "../terminal/ui.js"];
  const results = await Promise.allSettled(modules.map((name) => import(name)));
  let ready = true;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    let ok = result.status === "fulfilled";
    if (ok && modules[i] === "better-sqlite3") {
      let db;
      try {
        db = new result.value.default(":memory:");
        ok = db.prepare("SELECT 1 AS ok").get().ok === 1;
      } catch { ok = false; }
      finally { db?.close(); }
    }
    ready &&= ok;
    output(`${modules[i]}: ${ok ? "OK" : "indisponível; extraia novamente o pacote completo"}`);
  }
  return ready;
}
