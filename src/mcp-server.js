// SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
// SPDX-License-Identifier: MIT
// Research-Project: PayPal Agentic Guardrail
// Research-Author: Francisco Angulo de Lafuente
// Research-ORCID: https://orcid.org/0009-0001-1634-7063
// Research-Date: 2026-11-07
/**
 * The agent-facing surface, as a Model Context Protocol server over stdio.
 *
 * The whole tool surface is two tools:
 *
 *   `list_payment_operations`  - the catalogue: operation names, their bounded parameter
 *                                shapes, and whether a reference is needed. No bound values.
 *   `run_payment_operation`    - one operation name, parameters inside the declared ranges, and
 *                                optionally a reference the broker issued earlier.
 *
 * There is no tool that takes a URL, a header, a payee, a credential or a policy change. That
 * is the design: the interface itself is the guardrail, so a model that has been talked into
 * anything still has nothing to talk with.
 *
 * Implemented against the JSON-RPC 2.0 framing MCP uses over stdio, with no SDK dependency.
 */

import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2024-11-05';

function parameterSchema(entry) {
  const properties = {};
  const required = [];
  for (const parameter of entry.parameters) {
    required.push(parameter.name);
    if (parameter.type === 'decimal') {
      properties[parameter.name] = {
        type: 'string',
        pattern: '^(0|[1-9]\\d{0,9})\\.\\d{2}$',
        description: `decimal string between ${parameter.min} and ${parameter.max} inclusive`
      };
    } else if (parameter.type === 'integer') {
      properties[parameter.name] = {
        type: 'integer', minimum: parameter.min, maximum: parameter.max
      };
    } else if (parameter.type === 'enum') {
      properties[parameter.name] = { type: 'string', enum: [...parameter.values] };
    } else {
      properties[parameter.name] = {
        type: 'string', maxLength: parameter.max_length,
        description: 'plain text; URLs, email addresses and bank identifiers are rejected'
      };
    }
  }
  return { properties, required };
}

export function createMcpHandler({ broker }) {
  const tools = () => {
    const catalogue = broker.catalogue();
    const operationNames = catalogue.map(entry => entry.name);
    const describe = catalogue.map(entry => {
      const schema = parameterSchema(entry);
      const parameters = entry.parameters.length === 0
        ? 'no parameters'
        : entry.parameters.map(parameter => parameter.name).join(', ');
      return `- ${entry.name}: ${entry.description} (${parameters}` +
        `${entry.requires_reference ? `; requires a ${entry.requires_reference} this broker issued` : ''}` +
        `${entry.approval === 'none' ? '' : `; approval: ${entry.approval}`})` +
        ` [schema: ${JSON.stringify(schema.properties)}]`;
    }).join('\n');

    return [
      {
        name: 'list_payment_operations',
        description: 'List the payment operations the operator has authorised, with the exact ' +
          'parameter ranges each one accepts. Call this first.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'run_payment_operation',
        description: 'Run one authorised payment operation. You choose only the operation name ' +
          'and its parameters, inside the operator\'s declared ranges. The payee, the currency ' +
          'and the destination are fixed by the operator and cannot be set here.\n' +
          `Available operations:\n${describe}`,
        inputSchema: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: operationNames },
            params: { type: 'object', description: 'parameters for this operation; see its schema' },
            reference: {
              type: 'string',
              description: 'an id this broker returned earlier, when the operation needs one'
            }
          },
          required: ['operation'],
          additionalProperties: false
        }
      }
    ];
  };

  return async function handle(message) {
    const { id, method, params } = message;
    const reply = result => ({ jsonrpc: '2.0', id, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

    if (method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'paypal-agentic-guardrail', version: '1.0.0' }
      });
    }
    if (method === 'notifications/initialized' || method === 'ping') {
      return id === undefined ? null : reply({});
    }
    if (method === 'tools/list') return reply({ tools: tools() });

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'list_payment_operations') {
        return reply({
          content: [{ type: 'text', text: JSON.stringify(broker.catalogue(), null, 2) }]
        });
      }
      if (name === 'run_payment_operation') {
        const result = await broker.execute({
          operation: args.operation, params: args.params ?? {}, reference: args.reference
        });
        return reply({
          content: [{ type: 'text', text: JSON.stringify({ ...result }) }],
          isError: result.ok !== true
        });
      }
      return fail(-32601, `unknown tool: ${name}`);
    }

    return fail(-32601, `unknown method: ${method}`);
  };
}

export function serveStdio({ broker }) {
  const handle = createMcpHandler({ broker });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async line => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
      // A bare `null` parses fine and then takes the server down on destructuring.
      if (message === null || typeof message !== 'object') throw new Error('not an object');
    } catch {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' }
      })}\n`);
      return;
    }
    try {
      const response = await handle(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: message.id ?? null,
        error: { code: -32603, message: error.message }
      })}\n`);
    }
  });
}
