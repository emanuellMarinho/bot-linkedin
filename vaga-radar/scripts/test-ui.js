import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { harness, fixtures } from "../tests/helpers.js";
import { normalizePosting } from "../src/providers/index.js";

const h = harness({
  provider: async (source) => ({
    jobs: fixtures[source.provider].jobs.map((item) => ({
      ...normalizePosting(source.provider, item, source),
      provenance: "demo",
      title: `[DEMONSTRAÇÃO] ${item.title}`,
    })),
    errors: [],
  }),
});
const server = h.app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
fs.mkdirSync("test-results", { recursive: true });
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "pt-BR",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(base);
  await page
    .getByRole("heading", { name: "Um olhar para as oportunidades." })
    .waitFor();
  await page.locator('nav a[data-nav="profile"]').click();
  await page
    .getByLabel("Nome profissional", { exact: true })
    .fill("Perfil de demonstração");
  await page
    .getByLabel("Resumo profissional", { exact: true })
    .fill(
      "Desenvolvo aplicações web. Texto fornecido no teste de demonstração.",
    );
  for (const skill of ["JavaScript", "Node.js", "SQL"])
    await page.getByLabel(skill, { exact: true }).check();
  await page.getByRole("button", { name: "Adicionar experiência" }).click();
  await page
    .locator('#experiences [data-field="company"]')
    .fill("Empresa de demonstração");
  await page.locator('#experiences [data-field="role"]').fill("Desenvolvedor");
  await page
    .locator('#experiences [data-field="description"]')
    .fill("Experiência fictícia identificada apenas neste teste.");
  await page
    .getByRole("button", { name: "Salvar perfil e recalcular compatibilidade" })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('#profile-form input[name="name"]')?.value ===
        "Perfil de demonstração" &&
      !document.querySelector('#profile-form button[type="submit"]').disabled,
  );
  await page
    .locator('#resume-form input[type="file"]')
    .setInputFiles({
      name: "DEMONSTRACAO.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nDemonstração"),
    });
  await page
    .getByRole("button", { name: "Adicionar versão", exact: true })
    .click();
  await page.getByRole("link", { name: /DEMONSTRACAO.pdf/ }).waitFor();
  await page.locator('nav a[data-nav="settings"]').click();
  await page
    .locator('#source-form select[name="provider"]')
    .selectOption("greenhouse");
  await page.locator('#source-form input[name="board"]').fill("fixture");
  await page
    .locator('#source-form input[name="company"]')
    .fill("DEMONSTRAÇÃO — Empresa fictícia");
  await page
    .getByRole("button", { name: "Adicionar fonte", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Pausar fonte", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /Coletar agora/ }).click();
  await page.getByRole("heading", { name: "Histórico de coletas" }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector("main")?.textContent.includes("1 recebidas"),
  );
  await page.locator('nav a[data-nav="jobs"]').click();
  await page.getByLabel("Tecnologia", { exact: true }).fill("Node.js");
  await page.getByRole("button", { name: "Aplicar filtros" }).click();
  await page.getByRole("button", { name: "Ver detalhes", exact: true }).click();
  await page
    .getByRole("button", { name: "Preparar candidatura", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Preparação da candidatura", exact: true })
    .waitFor();
  assert.ok(
    (await page.locator("#detail-content").textContent()).includes(
      "Perfil de demonstração",
    ),
  );
  const apps = await (
    await context.request.get(base + "/api/applications")
  ).json();
  assert.equal(apps[0].status, "prepared");
  assert.equal(apps[0].sent_at, null);
  await page
    .locator('#application-form select[name="resumeId"]')
    .selectOption("1");
  await page
    .locator('#application-form textarea[name="notes"]')
    .fill("Dados de demonstração revisados.");
  await page
    .getByRole("button", { name: "Salvar anotações e currículo" })
    .click();
  await page
    .getByRole("button", { name: "Candidatura iniciada", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Registrar envio confirmado" })
    .waitFor();
  await page
    .getByLabel("Confirmo que enviei esta candidatura na plataforma original.")
    .check();
  await page
    .getByRole("button", { name: "Registrar envio confirmado" })
    .click();
  await page
    .getByRole("button", { name: "Em entrevista", exact: true })
    .waitFor();
  assert.equal(
    (await (await context.request.get(base + "/api/applications")).json())[0]
      .status,
    "sent",
  );
  await page.screenshot({
    path: "test-results/candidatura-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Fechar detalhes" }).click();
  // Também verifica importação manual e parser de alerta pela interface.
  await page.locator('nav a[data-nav="import"]').click();
  await page
    .locator('#alert-form textarea[name="text"]')
    .fill(
      "Alerta recebido: https://www.linkedin.com/jobs/view/123456789?trk=email",
    );
  await page.getByRole("button", { name: "Ler conteúdo fornecido" }).click();
  await page.getByRole("button", { name: /Usar https/ }).click();
  await page
    .locator('#import-form input[name="title"]')
    .fill("[DEMONSTRAÇÃO] Desenvolvedor JavaScript Junior");
  await page
    .locator('#import-form input[name="company"]')
    .fill("DEMONSTRAÇÃO — Manual");
  await page.getByRole("button", { name: "Importar e analisar" }).click();
  await page
    .getByRole("heading", {
      name: "[DEMONSTRAÇÃO] Desenvolvedor JavaScript Junior",
    })
    .waitFor();
  await page.getByRole("button", { name: "Fechar detalhes" }).click();
  await page.locator('nav a[data-nav="dashboard"]').click();
  await page
    .getByRole("heading", { name: "Um olhar para as oportunidades." })
    .waitFor();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    "dashboard",
    "jobs",
    "applications",
    "profile",
    "settings",
    "import",
  ]) {
    await page.goto(base + "/#" + route);
    await page.locator("main h1").waitFor();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    assert.equal(overflow, false, `Overflow horizontal na tela ${route}`);
    await page.screenshot({
      path: `test-results/${route}-mobile.png`,
      fullPage: true,
    });
  }
  await page.goto(base + "/#jobs");
  await page
    .getByRole("button", { name: "Ver detalhes", exact: true })
    .first()
    .click();
  await page
    .getByRole("heading", { name: "Descrição da oportunidade" })
    .waitFor();
  assert.equal(
    await page.evaluate(() => {
      const d = document.querySelector("dialog");
      return d.scrollWidth > d.clientWidth + 1;
    }),
    false,
    "Overflow no modal mobile",
  );
  await page.screenshot({
    path: "test-results/detalhes-mobile.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("dialog").open);
  await page.getByRole("button", { name: "Alternar tema" }).click();
  assert.equal(
    await page
      .locator("body")
      .evaluate((body) => body.classList.contains("light")),
    true,
  );
  await page.reload();
  await page.locator("main h1").waitFor();
  assert.equal(
    await page
      .locator("body")
      .evaluate((body) => body.classList.contains("light")),
    true,
  );
  await page.screenshot({
    path: "test-results/jobs-mobile-light.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Chromium desktop 1440px e mobile 390px; 6 telas sem overflow, coleta com fixture, filtros, perfil, currículo, importação de alerta, preparação, confirmação de envio e histórico.",
  );
  console.log(
    "Screenshots: test-results/. Dados de demonstração isolados; nenhuma candidatura real enviada.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  h.close();
}
