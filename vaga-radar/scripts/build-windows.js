import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export function assertWindowsRuntime(
  platform = process.platform,
  arch = process.arch,
) {
  if (platform !== "win32" || arch !== "x64") {
    throw new Error(
      "O executável Windows precisa ser compilado e testado em Windows x64. Use o workflow Windows bot no GitHub Actions; este comando não gera um .exe falso no Linux.",
    );
  }
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("Use Node.js 24 LTS para compilar o pacote Windows.");
  }
}

export function seaConfiguration(launcher, output) {
  return {
    main: launcher,
    output,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    // External ES modules are loaded using import(); code cache disables it.
    useCodeCache: false,
    execArgv: ["--use-env-proxy"],
    execArgvExtension: "none",
  };
}

function execute(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "Uma etapa da compilação falhou; consulte a saída anterior.",
    );
  }
}

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  const result = candidates.find(
    (candidate) => candidate && fs.existsSync(candidate),
  );
  if (!result)
    throw new Error(
      "npm CLI não encontrado. Execute npm run build:windows com o Node oficial instalado.",
    );
  return result;
}

export function buildWindows() {
  assertWindowsRuntime();
  const staging = fs.mkdtempSync(
    path.join(os.tmpdir(), "vaga-radar-windows-build-"),
  );
  const portable = path.join(staging, "VagaRadar");
  const application = path.join(portable, "app");
  const output = path.join(projectRoot, "dist");
  const zip = path.join(output, "VagaRadar-Windows-x64.zip");
  const executable = path.join(portable, "VagaRadar.exe");
  const blob = path.join(staging, "sea-prep.blob");
  const seaConfigFile = path.join(staging, "sea-config.json");

  try {
    fs.mkdirSync(application, { recursive: true });
    fs.mkdirSync(output, { recursive: true });
    for (const name of ["package.json", "package-lock.json"]) {
      fs.copyFileSync(
        path.join(projectRoot, name),
        path.join(application, name),
      );
    }
    fs.cpSync(path.join(projectRoot, "src"), path.join(application, "src"), {
      recursive: true,
    });
    // Install on Windows itself so better-sqlite3 matches this Node ABI/platform.
    execute(
      process.execPath,
      [npmCli(), "ci", "--omit=dev", "--no-audit", "--no-fund"],
      application,
    );
    fs.copyFileSync(
      path.join(projectRoot, "bot.example.json"),
      path.join(portable, "bot.example.json"),
    );
    fs.copyFileSync(
      path.join(projectRoot, "bot.example.json"),
      path.join(application, "bot.example.json"),
    );
    fs.copyFileSync(
      path.join(projectRoot, "..", "LICENSE"),
      path.join(portable, "LICENSE"),
    );
    const nodeLicense = path.join(path.dirname(process.execPath), "LICENSE");
    if (!fs.existsSync(nodeLicense)) {
      throw new Error(
        "LICENSE da distribuição oficial do Node não encontrado; use o ZIP oficial ou setup-node no workflow.",
      );
    }
    fs.copyFileSync(nodeLicense, path.join(portable, "NODE-LICENSE.txt"));
    fs.writeFileSync(
      path.join(portable, "LEIA-ME.txt"),
      [
        "Vaga Radar — bot para Windows x64",
        "",
        "Extraia todo o ZIP. Mantenha app/ ao lado de VagaRadar.exe.",
        "Este pacote inclui Node.js e não exige Node instalado no computador de uso.",
        "Abra VagaRadar.exe. Na primeira execução, o assistente do terminal pergunta seus dados e salva a configuração local.",
        "Informe o caminho do seu currículo, telefone e integrações que deseja usar; use somente dados profissionais reais.",
        "As chaves são confidenciais: não compartilhe os arquivos de configuração gerados nem os envie ao GitHub.",
        "Mantenha o terminal aberto enquanto o bot trabalha. Use Ctrl+C para encerrar com segurança.",
        "As etapas externas do WhatsApp Business, como aprovação do template e webhook HTTPS, continuam dependendo da Meta.",
        "Consulte os comandos: VagaRadar.exe --help",
        "Execute uma vez: VagaRadar.exe --config C:\\caminho\\bot.json --once",
        "Execução contínua: VagaRadar.exe --config C:\\caminho\\bot.json --watch",
        "Não há painel web. O programa precisa estar ativo para executar novos ciclos.",
        "Nenhuma senha do LinkedIn é solicitada. Envio depende do conector, das permissões da plataforma e do consentimento configurado.",
        "O executável desta compilação não possui assinatura Authenticode do desenvolvedor.",
        "Não contorne bloqueios de segurança; builds e testes ficam registrados no GitHub Actions.",
        "",
      ].join("\r\n"),
      { encoding: "utf8" },
    );
    fs.writeFileSync(
      seaConfigFile,
      JSON.stringify(
        seaConfiguration(
          path.join(projectRoot, "scripts", "sea-launcher.cjs"),
          blob,
        ),
        null,
        2,
      ),
    );
    execute(
      process.execPath,
      ["--experimental-sea-config", seaConfigFile],
      staging,
    );
    fs.copyFileSync(process.execPath, executable);

    // Node's official SEA guide makes signature removal optional on Windows.
    // postject may warn that modifying the copied Node binary invalidates its
    // vendor signature. This build is an unsigned product; it is never described
    // as carrying Node's original signature or a developer signing certificate.
    execute(
      process.execPath,
      [
        require.resolve("postject/dist/cli.js"),
        executable,
        "NODE_SEA_BLOB",
        blob,
        "--sentinel-fuse",
        fuse,
      ],
      staging,
    );
    execute(executable, ["--help"], portable);

    // Use environment arguments to avoid interpolating filesystem paths into
    // PowerShell code; generated artifact is the only replaced output.
    const previousSource = process.env.VAGA_RADAR_BUILD_SOURCE;
    const previousZip = process.env.VAGA_RADAR_BUILD_ZIP;
    process.env.VAGA_RADAR_BUILD_SOURCE = portable;
    process.env.VAGA_RADAR_BUILD_ZIP = zip;
    try {
      execute(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:VAGA_RADAR_BUILD_SOURCE -DestinationPath $env:VAGA_RADAR_BUILD_ZIP -Force",
        ],
        staging,
      );
    } finally {
      if (previousSource === undefined)
        delete process.env.VAGA_RADAR_BUILD_SOURCE;
      else process.env.VAGA_RADAR_BUILD_SOURCE = previousSource;
      if (previousZip === undefined) delete process.env.VAGA_RADAR_BUILD_ZIP;
      else process.env.VAGA_RADAR_BUILD_ZIP = previousZip;
    }
    console.log("Pacote criado: dist/VagaRadar-Windows-x64.zip");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    buildWindows();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
