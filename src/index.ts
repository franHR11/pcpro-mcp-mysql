#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as mysql from 'mysql2/promise';
import { URL } from 'url';

interface DatabaseConfig {
  host: string;
  user: string;
  password: string;
  database: string;
  port?: number;
}

function isErrorWithMessage(error: unknown): error is { message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  return String(error);
}

function parseMySQLUrl(url: string): DatabaseConfig {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'mysql:') {
      throw new Error('Invalid MySQL URL protocol');
    }

    return {
      host: parsedUrl.hostname,
      user: parsedUrl.username || '',
      password: parsedUrl.password || '',
      database: parsedUrl.pathname.slice(1),
      port: parsedUrl.port ? parseInt(parsedUrl.port, 10) : 3306,
    };
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(`Invalid MySQL URL: ${error.message}`);
    }
    throw new Error('Invalid MySQL URL: Unknown error');
  }
}

export const configSchema = z.object({
  mysqlUrl: z
    .string()
    .describe('MySQL connection URL (e.g. mysql://user:password@host:3306/database)')
    .optional(),
  host: z.string().describe('Database host').optional(),
  user: z.string().describe('Database user').optional(),
  password: z.string().describe('Database password').optional(),
  database: z.string().describe('Database name').optional(),
  port: z.number().describe('Database port').default(3306).optional(),
});

type Config = z.infer<typeof configSchema>;

export default function createServer({ config }: { config: Config }) {
  const server = new McpServer({
    name: 'mysql-server',
    version: '1.0.0',
  });

  let connection: mysql.Connection | null = null;
  let dbConfig: DatabaseConfig | null = null;

  function resolveConfigFromServerConfig() {
    if (config.mysqlUrl) {
      dbConfig = parseMySQLUrl(config.mysqlUrl);
      return;
    }

    if (config.host && config.user && config.password !== undefined && config.database) {
      dbConfig = {
        host: config.host,
        user: config.user,
        password: config.password,
        database: config.database,
        port: config.port ?? 3306,
      };
      return;
    }

    dbConfig = null;
  }

  async function ensureConnection() {
    if (!dbConfig) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Database configuration not set. Provide configuration or use connect_db tool first.'
      );
    }

    if (!connection) {
      try {
        connection = await mysql.createConnection(dbConfig);
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to connect to database: ${getErrorMessage(error)}`
        );
      }
    }
  }

  resolveConfigFromServerConfig();

  server.registerTool(
    'connect_db',
    {
      title: 'Connect to MySQL database',
      description: 'Connect to MySQL database using URL or individual parameters',
      inputSchema: z.object({
        url: z
          .string()
          .describe('MySQL connection URL (e.g. mysql://user:password@host:3306/database)')
          .optional(),
        host: z.string().describe('Database host').optional(),
        user: z.string().describe('Database user').optional(),
        password: z.string().describe('Database password').optional(),
        database: z.string().describe('Database name').optional(),
        port: z.number().describe('Database port (optional)').optional(),
      }),
    },
    async ({ url, host, user, password, database, port }) => {
      let newConfig: DatabaseConfig | null = null;

      if (url) {
        try {
          newConfig = parseMySQLUrl(url);
        } catch (error: unknown) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid MySQL URL: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      } else if (host || user || password || database) {
        if (!host || !user || password === undefined || password === null || !database) {
          throw new McpError(
            ErrorCode.InvalidParams,
            'Missing required database configuration parameters'
          );
        }

        newConfig = {
          host,
          user,
          password,
          database,
          port,
        };
      }

      if (!newConfig && !dbConfig) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'No database configuration provided'
        );
      }

      if (connection) {
        await connection.end();
        connection = null;
      }

      if (newConfig) {
        dbConfig = newConfig;
      }

      try {
        await ensureConnection();
        return {
          content: [
            {
              type: 'text',
              text: 'Successfully connected to database',
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to connect to database: ${getErrorMessage(error)}`
        );
      }
    }
  );

  server.registerTool(
    'query',
    {
      title: 'Execute a SELECT query',
      description: 'Execute a SELECT query against the connected MySQL database',
      inputSchema: z.object({
        sql: z.string().describe('SQL SELECT query'),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .describe('Query parameters (optional)')
          .optional(),
      }),
    },
    async ({ sql, params }) => {
      await ensureConnection();

      if (!sql) {
        throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
      }

      if (!sql.trim().toUpperCase().startsWith('SELECT')) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Only SELECT queries are allowed with query tool'
        );
      }

      try {
        const [rows] = await connection!.query(sql, params || []);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(rows, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Query execution failed: ${getErrorMessage(error)}`
        );
      }
    }
  );

  server.registerTool(
    'execute',
    {
      title: 'Execute a non-SELECT query',
      description: 'Execute an INSERT, UPDATE, or DELETE query against the connected MySQL database',
      inputSchema: z.object({
        sql: z.string().describe('SQL query (INSERT, UPDATE, DELETE)'),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .describe('Query parameters (optional)')
          .optional(),
      }),
    },
    async ({ sql, params }) => {
      await ensureConnection();

      if (!sql) {
        throw new McpError(ErrorCode.InvalidParams, 'SQL query is required');
      }

      const normalizedSql = sql.trim().toUpperCase();
      if (normalizedSql.startsWith('SELECT')) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'Use query tool for SELECT statements'
        );
      }

      try {
        const [result] = await connection!.query(sql, params || []);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Query execution failed: ${getErrorMessage(error)}`
        );
      }
    }
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List all tables',
      description: 'List all tables in the connected MySQL database',
      inputSchema: z.object({}),
    },
    async () => {
      await ensureConnection();

      try {
        const [rows] = await connection!.query('SHOW TABLES');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(rows, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list tables: ${getErrorMessage(error)}`
        );
      }
    }
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe table structure',
      description: 'Get the structure of a specific table',
      inputSchema: z.object({
        table: z.string().describe('Table name'),
      }),
    },
    async ({ table }) => {
      await ensureConnection();

      if (!table) {
        throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
      }

      try {
        const [rows] = await connection!.query('DESCRIBE ??', [table]);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(rows, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to describe table: ${getErrorMessage(error)}`
        );
      }
    }
  );

  return server.server;
}
