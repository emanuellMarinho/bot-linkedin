import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWhatsAppConfig, checkWhatsAppConnection, validateWebhookUrl } from '../src/messaging/diagnostics.js';
import { sendQuestion } from '../src/messaging/whatsapp.js';

const config = {
  enabled: true,
  phoneNumberId: '123456789012',
  to: '5511999990000',
  accessTokenEnv: 'TEST_WHATSAPP_TOKEN',
  templateName: 'vaga_radar_duvida',
  language: 'pt_BR',
  apiVersion: 'v24.0',
  webhookUrl: 'https://webhook.example.org/webhook',
};
const env = {
  TEST_WHATSAPP_TOKEN: 'test-not-a-real-access-token',
  VAGA_META_APP_SECRET: 'test-not-a-real-app-secret',
  VAGA_WHATSAPP_VERIFY_TOKEN: 'test-not-a-real-verify-token',
};
const question = { id: 'PROFILE_NAME', text: 'Qual seu nome?' };

function noSecrets(report) {
  const text = JSON.stringify(report);
  for (const value of [...Object.values(env), config.to, config.phoneNumberId, config.webhookUrl])
    assert.ok(!text.includes(value));
}

test('diagnóstico informa ausência de remetente e webhook sem exibir valores privados', () => {
  const result = inspectWhatsAppConfig({ enabled: false, to: config.to }, { env: {} });
  assert.equal(result.ready, false);
  for (const code of ['WHATSAPP_DISABLED', 'SENDER_REQUIRED', 'ACCESS_TOKEN_REQUIRED', 'PUBLIC_WEBHOOK_REQUIRED', 'APP_SECRET_REQUIRED', 'VERIFY_TOKEN_REQUIRED'])
    assert.ok(result.issues.some(issue => issue.code === code), code);
  noSecrets(result);
  assert.deepEqual(inspectWhatsAppConfig(config, { env }), { ready: true, issues: [] });
});

test('sessão pessoal não exige API Business, token, template ou webhook', async () => {
  const personal = { transport: 'personal', enabled: true, to: config.to };
  assert.deepEqual(inspectWhatsAppConfig(personal, { env: {} }), { ready: true, issues: [] });
  const result = await checkWhatsAppConnection(personal, {
    env: {}, fetcher() { throw new Error('Unexpected network'); },
  });
  assert.equal(result.ready, false);
  assert.equal(result.issues[0].code, 'PERSONAL_SESSION_REQUIRED');
});

test('diagnóstico rejeita endpoints locais, credenciais em URL e redirecionamentos de configuração', () => {
  for (const url of [
    'http://example.org/webhook', 'https://localhost/webhook', 'https://127.0.0.1/webhook',
    'https://192.168.1.2/webhook', 'https://[::1]/webhook', 'https://app.local/webhook',
    'https://name:password@example.org/webhook', 'https://example.org/webhook?secret=value',
    'https://example.org/webhook#fragment', 'https://example.org:3001/webhook',
  ]) assert.equal(validateWebhookUrl(url), false, url);
  assert.equal(validateWebhookUrl(config.webhookUrl), true);
  assert.equal(validateWebhookUrl('https://example.org/service/webhook'), true);
});

test('configuração incompleta ou diagnóstico cancelado não consulta serviços', async () => {
  for (const options of [
    { config: { ...config, phoneNumberId: '' } },
    { config, signal: AbortSignal.abort() },
  ]) {
    let calls = 0;
    const result = await checkWhatsAppConnection(options.config, {
      env, signal: options.signal, fetcher() { calls++; throw new Error('No network'); },
    });
    assert.equal(result.ready, false);
    assert.equal(calls, 0);
  }
});

test('diagnóstico verifica remetente e desafio HTTPS sem enviar mensagens ou afirmar entrega', async () => {
  const urls = [];
  const result = await checkWhatsAppConnection(config, {
    env,
    async fetcher(url, options) {
      urls.push(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      const endpoint = new URL(url);
      if (endpoint.hostname === 'graph.facebook.com') {
        assert.equal(endpoint.pathname, '/v24.0/123456789012');
        assert.equal(endpoint.search, '?fields=id');
        assert.equal(options.headers.Authorization, `Bearer ${env.TEST_WHATSAPP_TOKEN}`);
        return Response.json({ id: config.phoneNumberId });
      }
      assert.equal(options.headers, undefined);
      assert.equal(endpoint.searchParams.get('hub.verify_token'), env.VAGA_WHATSAPP_VERIFY_TOKEN);
      return new Response(endpoint.searchParams.get('hub.challenge'));
    },
  });
  assert.equal(urls.length, 2);
  assert.equal(result.ready, true);
  assert.deepEqual(result.checks, { configuration: 'passed', credentials: 'passed', webhook: 'passed' });
  assert.equal(result.deliveryVerified, false);
  assert.equal(result.templateVerified, false);
  assert.equal(result.subscriptionVerified, false);
  noSecrets(result);
});

test('falhas de token, endpoint errado e rede são informadas sem vazar respostas', async () => {
  for (const behavior of ['denied', 'wrong-body', 'network']) {
    const result = await checkWhatsAppConnection(config, {
      env,
      async fetcher(url) {
        if (behavior === 'network') throw new Error(env.TEST_WHATSAPP_TOKEN);
        if (behavior === 'denied') return new Response(env.TEST_WHATSAPP_TOKEN, { status: 403 });
        return Response.json({ id: 'incorrect', private: env.VAGA_META_APP_SECRET });
      },
    });
    assert.equal(result.ready, false);
    assert.equal(result.checks.credentials, 'failed');
    assert.equal(result.checks.webhook, 'failed');
    noSecrets(result);
  }
});

test('cancelamento antes do envio não consulta API e durante envio fica inconclusivo', async () => {
  const options = { ...config, accessToken: env.TEST_WHATSAPP_TOKEN };
  let calls = 0;
  await assert.rejects(sendQuestion(question, {
    ...options, signal: AbortSignal.abort(), fetcher() { calls++; },
  }), error => error.code === 'CANCELLED');
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(sendQuestion(question, {
    ...options, signal: controller.signal,
    async fetcher(url, request) {
      calls++;
      controller.abort();
      assert.equal(request.signal.aborted, true);
      throw new Error('Abort');
    },
  }), error => error.code === 'AMBIGUOUS' && error.requiresReconciliation);
  assert.equal(calls, 1);
});

test('erros Meta HTTP 400 distinguem token e rate limit sem revelar texto privado', async () => {
  for (const [providerCode, expected] of [[190, 'AUTHORIZATION'], [130429, 'RATE_LIMIT'], [131056, 'RATE_LIMIT'], [132001, 'REJECTED']]) {
    await assert.rejects(sendQuestion(question, {
      ...config, accessToken: env.TEST_WHATSAPP_TOKEN,
      fetcher: async () => Response.json({ error: { code: providerCode, message: env.TEST_WHATSAPP_TOKEN } }, { status: 400 }),
    }), error => {
      assert.equal(error.code, expected);
      assert.equal(error.providerCode, providerCode);
      assert.ok(!error.message.includes(env.TEST_WHATSAPP_TOKEN));
      return true;
    });
  }
});
