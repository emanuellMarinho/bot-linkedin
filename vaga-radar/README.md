# Vaga Radar Bot

Aplicativo de terminal para procurar vagas, preparar currículos ATS e acompanhar candidaturas. A configuração acontece por etapas, com uma ação de cada vez. As dúvidas chegam pelo canal escolhido: **WhatsApp, SMS ou o próprio terminal**. GPT é opcional.

## Começar no Windows

1. Baixe **VagaRadar-Windows-x64** no [workflow Windows bot](https://github.com/emanuellMarinho/bot-linkedin/actions/workflows/windows-bot.yml), pela seção **Artifacts** de uma execução concluída com sucesso. O GitHub exige login para baixar.
2. Extraia tudo. Mantenha **`VagaRadar.exe` e `app/` juntos**; o runtime Node está incluído.
3. Abra `VagaRadar.exe` e siga as sete etapas: perfil, currículo, rotina, canal de avisos, GPT, candidaturas e revisão final.
4. Aguarde a validação do currículo e a conclusão da conexão escolhida. O bot apresenta o resultado de cada etapa antes de avançar.
5. Quando o menu aparecer, acompanhe as vagas na mesma janela. Mantenha o terminal aberto; **0** ou **Ctrl+C** encerra.

Para reorganizar uma configuração existente, execute:

```powershell
.\VagaRadar.exe --setup
```

O assistente mostra um resumo antes de salvar. Enter mantém valores anteriores quando há um padrão; chaves são digitadas sem aparecer. Cancelar antes da confirmação preserva a configuração anterior. O currículo é validado e copiado para a pasta privada, mantendo o original.

## Escolher onde receber as perguntas

| Canal | O que precisa | Como responder |
| --- | --- | --- |
| WhatsApp pessoal | Ler o QR com a conta do número informado | Usar **Responder** na pergunta ou `ID: resposta`, na conversa consigo mesmo |
| SMS | Conta Twilio, credenciais e número remetente habilitado para SMS | Responder por SMS no formato `ID: resposta` |
| Terminal | Apenas manter a janela aberta | Escolher **3** e digitar o número da pergunta com a resposta |

A conexão é uma etapa anterior à busca. O aplicativo aguarda o WhatsApp ou valida o serviço SMS antes de começar as consultas. Se o canal falhar, apresenta opções para tentar novamente, configurar SMS, continuar pelo terminal ou encerrar. Escolher o terminal permite usar o bot enquanto o canal externo é resolvido; isso não é anunciado como WhatsApp ou SMS conectado.

### WhatsApp pessoal

No celular, abra **WhatsApp → Aparelhos conectados → Conectar aparelho** e leia o QR exibido no terminal. Durante o pareamento, o QR fica separado das mensagens da rotina. Aguarde a confirmação da conta antes da próxima etapa.

As perguntas chegam na **conversa com você mesmo**. A sessão fica em `data/whatsapp-session/` e é reutilizada. O número conectado precisa corresponder ao configurado. O modo pessoal usa Baileys como dispositivo vinculado e pode precisar de atualização ou novo pareamento quando o WhatsApp mudar.

### SMS

O SMS dispensa QR code e webhook público. Ele usa o serviço **Twilio**, que exige:

- Conta ativa, Account SID e Auth Token.
- Número remetente da conta habilitado para SMS e compatível com o destino.
- Seu número de celular com país e DDD, no formato internacional, por exemplo `+5511999999999`.

O assistente pede esses dados localmente e salva as credenciais no JSON privado. **Informar somente o celular não cria um serviço de envio.** Mensagens podem ter custo; contas de teste, números e permissões geográficas seguem as regras da conta Twilio.

A validação inicial consulta a conta e o número remetente, sem enviar mensagem. Para confirmar entrega e resposta de verdade, use o teste explícito. O bot consulta as respostas recebidas pelo serviço; não precisa abrir uma porta na internet no seu computador.

## Menu e acompanhamento

```text
1  Ver vagas
2  Ver candidaturas
3  Responder perguntas
4  Ajuda
0  Encerrar

Comando >
```

Em **3**, cada pergunta recebe um número curto. Digite, por exemplo, `1: minha resposta`. Os IDs anteriores continuam aceitos. Cada comando termina antes de o próximo ser executado, e atualizações da rotina preservam uma resposta que você esteja digitando.

Também é possível digitar `vagas`, `candidaturas`, `vaga 12` e `ajuda`. A visão mostra empresa, compatibilidade, situação, link e pendências. Esses comandos também funcionam na conversa WhatsApp autenticada. SMS aceita respostas identificadas às perguntas.

Nome, e-mail, salário, autorização de trabalho e consentimentos ausentes são consultados conforme a candidatura precisar. Uma pergunta específica pausa aquela vaga; a resposta validada permite retomar durante o horário de trabalho. Informações importantes não são inventadas pelo bot.

## Rotina e candidaturas

A busca é contínua durante a janela configurada, inicialmente **08h–20h, America/Sao_Paulo (12 horas)**. Cada fonte respeita um limite técnico mínimo de 30 segundos, com espera adicional para erros ou limites da plataforma. Não há espera fixa de uma hora entre rodadas. O computador e o processo precisam permanecer ligados.

O envio automático tem suporte inicial aos formulários públicos **Lever em `jobs.lever.co`**, com Edge/Chrome no Windows ou Chromium em `CHROMIUM_PATH` no Linux. Ative o envio no assistente. Campos conhecidos usam os dados confirmados e o currículo preparado; campos obrigatórios desconhecidos geram perguntas. CAPTCHA, login e controles incompatíveis ficam pendentes para revisão.

Uma tentativa por rodada e três por 24 horas são os limites padrão. Um envio só é confirmado com evidência apresentada pela plataforma. Resultado ambíguo não é repetido automaticamente. Greenhouse e Ashby são fontes de consulta; outros sites ainda precisam de um conector próprio para envio. Não há candidatura universal em qualquer plataforma.

A integração Lever API anterior permanece disponível no modo `autoApply.mode: "api"`, mediante chave da integração autorizada da empresa contratante. Essa chave não vem do login normal de candidato. O modo de navegador usa `autoApply.mode: "browser"` e não exige chave da empresa.

## Currículo e GPT

Informe PDF com texto extraível ou TXT UTF-8, até 2 MB. PDF escaneado precisa de OCR prévio. O bot gera versões PDF/TXT por vaga, preserva os fatos do original e destaca habilidades confirmadas e evidenciadas. A apresentação é adequada à leitura automática, mas **não garante aprovação ou nota de ATS**.

GPT é opcional. Quando habilitado com sua chave/modelo, recebe texto do currículo, vaga e habilidades confirmadas pela API OpenAI, com cobrança da sua conta. O bot usa Responses API com `store:false`, limite de saída e timeout. O modelo sugere organização e dúvidas; dados pessoais desconhecidos continuam dependendo de você. Sem GPT, a preparação determinística permanece disponível.

## Comandos de configuração e teste

Encerre uma execução antes de abrir outra no mesmo diretório de dados.

```powershell
.\VagaRadar.exe --setup            # Reconfigurar pelo assistente
.\VagaRadar.exe --sms-setup        # Configurar somente SMS
.\VagaRadar.exe --check-sms        # Validar conta/número SMS sem enviar
.\VagaRadar.exe --test-sms         # Enviar teste e aguardar resposta por SMS
.\VagaRadar.exe --connect-whatsapp # Ativar pareamento pessoal em configuração antiga
.\VagaRadar.exe --reset-whatsapp   # Remover a sessão local do bot e gerar novo QR
.\VagaRadar.exe --check-whatsapp   # Verificar conexão sem mensagem
.\VagaRadar.exe --test-whatsapp    # Enviar teste e aguardar resposta pelo WhatsApp
```

Os testes de mensagens só confirmam o fluxo completo após uma resposta recebida pelo canal. Aceitação do serviço não equivale a entrega ou resposta. Sem credenciais, o SMS é apresentado como pendente; nenhum sucesso é inventado.

## Dados e configuração

`bot.config.json`, `.env`, `data/` e a sessão WhatsApp são privados. As chaves digitadas ficam no **JSON local, sem criptografia**, com permissões restritas quando o sistema permite. Não compartilhe esses arquivos nem envie chaves pelo chat. Nenhum segredo é distribuído no pacote Windows.

Os caminhos relativos usam a pasta do arquivo de configuração. O bot mantém currículo, banco, perguntas e relatórios em `dataDir`; apenas uma execução por diretório é permitida. Faça backup com o aplicativo encerrado.

Campos principais: `notifications.channel` escolhe `whatsapp`, `sms` ou `terminal`; `sms` configura o serviço de mensagens; `search.continuous` ativa busca contínua; `workWindow` define início/duração/fuso; `sources` lista quadros públicos; `autoApply` controla permissões e limites. Configure 24 horas na rotina se desejar trabalho durante todo o dia.

Operadores com uma integração Meta existente podem usar `--advanced-setup` e `whatsapp.transport: "cloud"`. Esse modo continua exigindo remetente Business, template aprovado, token e webhook HTTPS com validação de assinatura; não faz parte do fluxo pessoal por QR ou do SMS.

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

`npm start` e o `.exe` permanecem abertos. `--once` executa uma rodada; `--collect-only` consulta sem enviar perguntas/candidaturas e dispensa a etapa de conexão. Sem terminal e sem configuração, é gravado um exemplo e retornado código 2. `--setup` exige terminal interativo.

O [workflow Windows](https://github.com/emanuellMarinho/bot-linkedin/actions/workflows/windows-bot.yml) instala pelo lockfile, testa e gera o pacote SEA para Windows x64. Compilação local: `npm ci` e `npm run build:windows`. O pacote inclui `app/`; o executável não possui assinatura Authenticode do desenvolvedor.

Resultados atuais são registrados em [docs/BOT-VALIDATION.md](docs/BOT-VALIDATION.md). Testes usam dados fictícios e serviços simulados; não comprovam entrega de SMS, pareamento de uma conta pessoal ou candidatura real em produção. Esses fluxos precisam ser confirmados com a conta configurada e resposta ao teste.

O painel anterior é opcional: `npm run web`, restrito ao localhost. Documentação: [API](docs/API.md), [fontes](docs/SOURCES.md), [validação inicial](docs/VALIDATION.md). Licença: [MIT](../LICENSE).
