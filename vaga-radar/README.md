# Vaga Radar Bot

Bot de terminal para ler seu currículo, buscar vagas em fontes públicas, preparar versões PDF/TXT para ATS e acompanhar candidaturas. O fluxo principal conecta seu **WhatsApp pessoal por QR code** e envia as dúvidas na conversa com você mesmo. GPT é opcional.

A busca é contínua durante a janela de trabalho, inicialmente **08h–20h, America/Sao_Paulo (12 horas)**. Ao terminar uma rodada, o bot consulta as fontes disponíveis novamente. Cada fonte tem um limite técnico mínimo de 30 segundos, com espera maior quando a plataforma solicita ou apresenta erros. Não há mais uma pausa fixa de uma hora entre rodadas.

## Primeiro uso no Windows

1. Baixe o artefato **VagaRadar-Windows-x64** no [build validado da versão 2.2](https://github.com/emanuellMarinho/bot-linkedin/actions/runs/40615734776), na seção **Artifacts**; o GitHub exige login para baixar.
2. Extraia o pacote inteiro, mantendo **`VagaRadar.exe` e `app/` juntos**. O runtime Node está incluído.
3. Abra `VagaRadar.exe`. Informe nome, e-mail, caminho do currículo, habilidades, número pessoal com país/DDD, horário e opções do bot. O assistente salva tudo em `bot.config.json` e copia o currículo para a pasta privada.
4. No celular, abra **WhatsApp → Aparelhos conectados → Conectar aparelho** e leia o QR code mostrado no terminal com a conta do número informado.
5. Mantenha o terminal aberto. Use **Ctrl+C** para encerrar.

A sessão WhatsApp é salva em `data/whatsapp-session/` e reutilizada no próximo início. O bot exige que a conta conectada corresponda ao número configurado. Não é necessário WhatsApp Business, token Meta, template ou webhook no modo pessoal. Esse modo usa um dispositivo vinculado por Baileys; mudanças no WhatsApp podem exigir atualização do conector ou novo pareamento.

Para atualizar uma configuração antiga que apenas guardava seu número:

```powershell
.\VagaRadar.exe --connect-whatsapp
```

Outros comandos:

```powershell
.\VagaRadar.exe --setup            # Alterar dados e chaves
.\VagaRadar.exe --reset-whatsapp   # Apagar a sessão local do bot e gerar novo QR
.\VagaRadar.exe --check-whatsapp   # Diagnosticar configuração/conexão sem enviar mensagem
.\VagaRadar.exe --test-whatsapp    # Enviar um teste e aguardar sua resposta
```

O teste de WhatsApp só confirma o fluxo completo após receber sua resposta. Aceitação pelo transporte, entrega e leitura são estados diferentes; uma mensagem aceita não é apresentada como resposta recebida. Se o celular desconectar a sessão, o bot informa a situação e mantém as perguntas no banco.

Pressionar Enter no assistente mantém o valor anterior. Chaves ficam ocultas durante a digitação. Ctrl+C cancela a configuração sem substituir o JSON anterior. Dados e chaves ficam em **JSON local privado, sem criptografia**; não compartilhe `bot.config.json`, `.env`, `data/` nem a sessão WhatsApp.

## Acompanhar vagas e responder dúvidas

Digite os mesmos comandos no terminal ou na conversa com você mesmo no WhatsApp:

| Comando | Resultado |
| --- | --- |
| `vagas` | Até dez oportunidades mais compatíveis, com ID, empresa, pontuação e situação |
| `candidaturas` | Candidaturas recentes, envios confirmados e pendências |
| `vaga 12` | Detalhes, link e dúvidas pendentes da vaga de ID 12 |
| `ajuda` | Lista dos comandos disponíveis |

Para responder uma dúvida pelo WhatsApp, use **Responder** na mensagem da pergunta, ou envie `ID_DA_PERGUNTA: sua resposta`. No terminal, use esse mesmo formato com ID. E-mails, respostas `sim`/`não` e opções de formulário são validados antes de persistir. Respostas duplicadas não substituem os dados já confirmados.

O bot usa os dados do currículo e do perfil para preencher campos conhecidos. Informações importantes ausentes — como autorização de trabalho, pretensão salarial ou consentimentos exigidos — são perguntadas ao candidato. Uma pergunta específica pausa aquela candidatura; as demais vagas continuam sendo processadas. Respostas ficam no banco e permitem retomar durante o horário de trabalho.

## Currículo, GPT e ATS

Informe PDF com texto extraível ou TXT UTF-8, até 2 MB. PDF escaneado precisa de OCR antes do uso. O bot preserva o arquivo original e gera versões por vaga em `data/tailored/`, além do pacote em `data/outbox/`.

O currículo ATS usa uma coluna e texto pesquisável, destaca habilidades confirmadas e evidenciadas no currículo e preserva os fatos fornecidos. Não cria cargos, empresas, datas, certificações ou experiência. A adaptação melhora a apresentação para leitura automática; **não garante aprovação nem pontuação de ATS**.

GPT pode ser ativado no assistente, com sua chave e modelo, ou por `VAGA_OPENAI_KEY`. A opção envia texto do currículo, vaga e habilidades confirmadas à API OpenAI, com cobrança da sua conta. O bot usa Responses API com `store:false`, limite de saída e timeout. O modelo sugere ordenação de habilidades e dúvidas; informações pessoais importantes continuam dependendo da sua resposta. Sem GPT, a preparação determinística continua.

## Candidaturas automáticas

O modo de navegador oferece suporte inicial aos formulários públicos **Lever em `jobs.lever.co`**, usando os dados do candidato e o currículo adaptado. Não exige chave da empresa. Requer Edge/Chrome disponível no Windows ou Chromium configurado em `CHROMIUM_PATH` no Linux. Ative o envio no assistente; a configuração usa `autoApply.mode: "browser"`.

O conector preenche os campos suportados, pergunta dados obrigatórios desconhecidos e retoma após a resposta. Formulários incompatíveis, login ou CAPTCHA ficam pendentes para acompanhamento. Os limites padrão são uma tentativa por rodada e três por 24 horas. Um envio só ganha confirmação quando a plataforma apresenta a confirmação esperada; timeout ou resultado ambíguo não é repetido automaticamente.

Greenhouse e Ashby são fontes de consulta. Os outros sites ainda precisam de um conector próprio para envio automático. O bot não oferece candidatura universal em qualquer plataforma. LinkedIn permanece por importação fornecida pelo usuário ou abertura manual.

A integração **Lever API** anterior continua disponível com `autoApply.mode: "api"`. Essa modalidade exige API key da integração autorizada da empresa contratante; o login de candidato não fornece a chave. Só um recibo válido `applicationId` confirma o envio pela API.

## Configuração e operação

Os caminhos relativos são resolvidos em relação ao arquivo de configuração. Currículos, banco SQLite, perguntas, respostas e relatórios ficam em `dataDir`, fora do painel opcional e do Git. Apenas uma execução por diretório de dados pode ficar ativa.

- `sources`: quadros públicos Greenhouse, Lever e Ashby; fontes ausentes da lista ficam pausadas, preservando histórico.
- `search.continuous`: busca contínua ativada por padrão. A espera técnica por fonte respeita limites e erros; `preferences.intervalHours` continua disponível para o modo periódico antigo.
- `workWindow`: início, duração e fuso. Configure 24 horas se desejar trabalho durante todo o dia; o padrão permanece 12 horas. Fora da janela, não inicia novo ciclo.
- `preferences`: país, modalidades, senioridades, contratos, nomenclaturas e pontuação mínima.
- `autoApply`: modalidade, ativação e limites de envio.
- `whatsapp.transport`: `personal` para QR ou `cloud` para uma integração Meta existente.

O computador e o processo precisam permanecer ligados. Não foi instalado agendamento nem serviço no seu computador. Faça backup de `data/` e da configuração com o bot encerrado.

## WhatsApp Cloud opcional

Operadores com integração Meta existente podem usar `--advanced-setup` e `whatsapp.transport: "cloud"`. O destino pode continuar sendo um número pessoal; o remetente precisa da conta/app Business, Phone Number ID, token válido, template aprovado e webhook HTTPS público terminado em `/webhook`.

O template usa dois parâmetros no corpo: texto da pergunta e ID. Exemplo: `O Vaga Radar precisa de uma informação: {{1}}. Responda a esta mensagem ou envie {{2}}: sua resposta.` O receptor valida assinatura HMAC dos bytes originais, número remetente, Phone Number ID e IDs das mensagens. Também recebe eventos de entrega/leitura/falha e respostas citando a mensagem original.

`VAGA_WHATSAPP_TOKEN` fornece o token de envio. `VAGA_META_APP_SECRET` e `VAGA_WHATSAPP_VERIFY_TOKEN` precisam ser valores locais reais para validar assinaturas/challenge; placeholders de proxy não servem como segredos locais. O assistente guarda esses valores no JSON privado quando informados. O receptor atende `127.0.0.1:3001` por padrão; HTTPS público exige infraestrutura externa. Não exponha o painel antigo para esse fim.

```bash
npm run bot -- --config bot.config.json --whatsapp-webhook
```

## Desenvolvimento e validação

Requer Node.js 24 LTS:

```bash
cd vaga-radar
npm ci
npm start
npm run bot -- --setup
npm test
npm run test:ui
```

`npm start` e o `.exe` sem argumentos permanecem em execução. `--once` executa uma rodada; `--collect-only` consulta sem enviar perguntas/candidaturas. Sem terminal e sem configuração, o bot grava um exemplo e retorna código 2. `--setup` exige terminal interativo.

O [workflow Windows](https://github.com/emanuellMarinho/bot-linkedin/actions/runs/40615734776) passou em Windows x64: instalação pelo lockfile, testes, geração SEA e execução do pacote extraído, incluindo dependências WhatsApp/navegador/PDF/SQLite. A suíte local final passou com 131 testes. Compilação local no Windows: `npm ci` e `npm run build:windows`. O pacote inclui `app/`; o executável não tem assinatura Authenticode do desenvolvedor.

Testes de integração usam serviços simulados e formulários interceptados; não enviam candidaturas reais, mensagens reais ou chamadas pagas de GPT. A conexão com seu WhatsApp só pode ser comprovada após ler o QR no seu computador e responder ao teste. A janela de trabalho é testada com relógio controlado, sem afirmar doze horas de produção contínua. Evidências em [docs/BOT-VALIDATION.md](docs/BOT-VALIDATION.md).

O painel anterior é opcional: `npm run web`, restrito ao localhost. Documentação: [API](docs/API.md), [fontes](docs/SOURCES.md), [validação inicial](docs/VALIDATION.md). Licença: [MIT](../LICENSE).
