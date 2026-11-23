import { createServer } from 'node:http';

const marker = 'AWF_PROJECT_AUTO_CONTEXT_CHECK';
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'g45model', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404); res.end(); return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const markerPresent = body.includes(marker);
    const hasProjectToolResult = parsed.messages?.some((message) => message.role === 'tool');
    const toolMessages = (parsed.messages ?? []).filter((message) => message.role === 'tool')
      .map((message) => ({ name: message.name, content: String(message.content).slice(0, 240) }));
    process.stdout.write(JSON.stringify({ marker_present: markerPresent, tool_result_present: Boolean(hasProjectToolResult), tool_messages: toolMessages }) + '\n');
    const latestToolContents = toolMessages.map((message) => message.content).join('\n');
    const hasStatusCard = toolMessages.some((message) =>
      /Projektkontext aktiv/u.test(message.content) && /A004/u.test(message.content) &&
      !/Created and selected A004/u.test(message.content));
    if (body.includes('Check whether the selected project context') && !hasStatusCard) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'awf-project-status-tool-call', object: 'chat.completion', created: 0, model: 'g45model',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'awf-project-status-1', type: 'function', function: {
            name: 'awf_project', arguments: JSON.stringify({ action: 'status' }),
          } }],
        } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    if (!body.includes('Check whether the selected project context') && body.includes('Create a project named Synthetic Gateway Pilot') && !/Created and selected A004/u.test(latestToolContents)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'awf-project-select-tool-call', object: 'chat.completion', created: 0, model: 'g45model',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'awf-project-select-1', type: 'function', function: {
            name: 'awf_project', arguments: JSON.stringify({ action: 'create', name: 'Synthetic Gateway Pilot' }),
          } }],
        } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    if (!body.includes('Check whether the selected project context') && body.includes('Create a project named Synthetic Gateway Pilot') && /Created and selected A004/u.test(latestToolContents)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'awf-project-created', object: 'chat.completion', created: 0, model: 'g45model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'PROJECT_CREATED_A004' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'awf-project-context-check', object: 'chat.completion', created: 0, model: 'g45model',
      choices: [{ index: 0, finish_reason: 'stop', message: {
        role: 'assistant', content: markerPresent ? 'PROJECT_CONTEXT_OK' : 'NO_PROJECT_CONTEXT',
      } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
server.listen(19346, '127.0.0.1');
