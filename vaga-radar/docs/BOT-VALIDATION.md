# Validação do modo bot v2

Esta evolução preserva o painel antigo como opção (`npm run web`) e muda o caminho principal (`npm start`) para execução sem interface. Resultados desta sessão:

- `npm test`: **69 passaram**, zero falhas/ignorados/cancelados. Inclui 27 verificações anteriores, pipeline sem servidor, currículo ATS real, GPT opcional, webhook/respostas WhatsApp e submissão Lever com fetch simulado.
- `npm run test:ui`: regressão Chromium desktop/mobile passou, sem mensagens/candidaturas reais.
- CLI `--help`: executado. Ciclo `--once --collect-only` isolado, com coleta pausada: executado e relatório persistido, sem iniciar servidor.
- Coleta real pelo entrypoint sem interface: **266 vagas recebidas e persistidas, zero erros**, em banco temporário isolado removido após validação. Sem perfil/currículo real fornecido, nenhuma preparação ou candidatura pessoal foi realizada nessa coleta.
- Currículos: PDFKit gerou PDFs de verdade e pdf-parse os releu nos testes. Fatos originais preservados, habilidades inexistentes rejeitadas, arquivos privados e versões reproduzíveis por conteúdo.
- Perguntas: teste encadeou pergunta ao WhatsApp falso, resposta assinada/deduplicada, persistência da resposta e retomada de preparação/envio simulado. Não houve mensagem real, pois as credenciais Meta e o destino não estão configurados.
- GPT: contrato Responses API e validação do plano testados com fixtures; zero consumo pago. Nenhuma chave está disponível nesta instância.
- Envio: connector Lever verifica recibo da API; timeout ambíguo persiste e não é repetido após reinício. Testes não autorizam ou comprovam envio real; não há credencial de integração da empresa nesta instância.
- Horário: limites 08h–20h de São Paulo e virada da meia-noite testados com relógio controlado. Não foram executadas doze horas contínuas de produção, nem instalado agendamento no computador do usuário.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilidades relatadas no momento da consulta.
- Windows: **build e smoke reais concluídos com sucesso** no [run 40607731691](https://github.com/emanuellMarinho/bot-linkedin/actions/runs/40607731691), commit `e8df71b`, duração 3m42s. O runner executou instalação pelo lockfile, npm test em Windows, geração SEA, extração do ZIP, `--help` do executável e ciclo isolado com relatório persistido/sem painel. Artefato `VagaRadar-Windows-x64`, 74,4 MB. O pacote é `.exe` mais diretório `app/`, não arquivo único. Esse smoke não comprova operação contínua de doze horas nem integrações externas com credenciais reais.

## Integrações e configuração pendentes

O programa está implementado e testado localmente; operação pessoal ponta a ponta ainda depende de currículo real, dados do candidato, credenciais e infraestrutura externa. WhatsApp precisa de API oficial Business, template aprovado, número permitido e receptor HTTPS com assinatura HMAC. GPT é opcional via chave própria. Envio Lever exige API key autorizada da integração da empresa, não o login de candidato. Outros destinos não possuem envio universal implementado.

Definições técnicas/fontes consultadas: SDK oficial OpenAI `openai/openai-node` (Responses), SDK oficial Meta `WhatsApp/WhatsApp-Nodejs-SDK` (mensagens/webhooks), documentação oficial `lever/postings-api`, documentação Node 24.19 Single Executable Applications. Docs OpenAI/Meta em seus sites estiveram bloqueados e foram consultados pelos repositórios oficiais; endpoints reais de mensagens/GPT/submissões não foram chamados.

As instruções de inicialização e os domínios opcionais foram salvos no rascunho do ambiente, preservando os domínios anteriores. Isso não ativa credenciais, publica hospedagem, disponibiliza webhook HTTPS ou instala um processo de doze horas no computador do usuário. README descreve configuração local; segredos nunca devem ser enviados em chat.

## Assistente de terminal v2.1

O `.exe` agora oferece configuração interativa no primeiro uso, salva dados e chaves no JSON local privado, copia o currículo validado, permite reconfigurar com `--setup` e permanece aberto executando a rotina até Ctrl+C. Node.js foi mantido para reutilizar o runtime Windows já validado e os módulos existentes; não é necessário instalar Node ao usar o pacote portátil completo.

- `npm test`: **77 testes passaram**, incluindo seis novos testes do assistente e dois do wrapper Windows.
- Teste com PTY Linux real: nome/e-mail/currículo/habilidades/número pessoal/GPT configurados com dados fictícios, chave digitada sem eco, JSON persistido, cópia do currículo conferida e inicialização contínua sem `--watch`. Ctrl+C encerrou com código 0. Fontes vazias impediram chamadas externas; nenhuma credencial real foi usada.
- Validação de erro/cancelamento: PDF inválido permite corrigir a entrada; cancelamento não grava configuração parcial; Enter preserva fontes, preferências e chaves anteriores. Chaves não aparecem como padrões nem no histórico readline.
- A API Business permanece opcional. Informar o número pessoal define apenas o destino, não autentica remetente. Não foi criada conexão WhatsApp Web/QR nem enviado login ou mensagem sem autorização.
- Build Windows do primeiro assistente: **sucesso em 3m53s**, incluindo instalação/testes/build/smoke, no workflow [40610371610](https://github.com/emanuellMarinho/bot-linkedin/actions/runs/40610371610), commit `69c2d13`. Os resultados acima de terminal real são Linux; o runner testa o executável Windows extraído em modo sem TTY, sem fingir digitação física no console Windows.

## Preferência por número pessoal sem pareamento

O usuário recusou QR code e cadastro Business no assistente. O fluxo básico foi reduzido a número pessoal; não inicia sessão WhatsApp nem afirma que o canal está conectado. As opções Meta/Lever de operador ficam apenas em `--advanced-setup`, preservando integrações existentes. Sem remetente autenticado, mensagens não são enviadas.

- `npm test`: **79 passaram**, incluindo número pessoal sem prompts Business/QR, carregamento privado de chave GPT e respostas locais validadas sem parar a busca.
- PTY Linux real repetido no fluxo básico: nenhuma pergunta Business/QR, chave sem eco, JSON salvo, execução contínua e Ctrl+C com saída 0. Sem chamadas externas.
- As respostas pelo terminal são persistidas com origem `terminal:` e o bot as consome na próxima verificação, como ocorre com respostas autenticadas vindas do canal externo.
