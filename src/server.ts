import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import mysql from "mysql2/promise";
import { z } from "zod";

type MySqlConfig = {
    host: string;
    user: string;
    database: string;
    password: string;
};

function resolveMySqlConfig(config: unknown): MySqlConfig {
    const c = (config ?? {}) as Record<string, unknown>;
    return {
        host: (c.mysqlHost as string) || process.env.MYSQL_HOST || "localhost",
        user: (c.mysqlUser as string) || process.env.MYSQL_USER || "root",
        database:
            (c.mysqlDatabase as string) || process.env.MYSQL_DATABASE || "",
        password:
            (c.mysqlPassword as string) || process.env.MYSQL_PASSWORD || "",
    };
}

// Esquema opcional de configuración de sesión para Smithery
export const configSchema = z.object({
    mysqlHost: z
        .string()
        .default("localhost")
        .describe("Host del servidor MySQL"),
    mysqlUser: z.string().describe("Usuario de MySQL"),
    mysqlDatabase: z.string().describe("Nombre de la base de datos MySQL"),
    mysqlPassword: z.string().describe("Contraseña del usuario MySQL"),
});

export default function createServer({
    config,
}: {
    config?: unknown;
}) {
    const dbConfig = resolveMySqlConfig(config);

    const server = new McpServer({
        name: "mysql-mcp-server",
        version: "1.0.0",
    });

    let connection: mysql.Connection | null = null;

    async function getConnection(): Promise<mysql.Connection> {
        if (!connection) {
            connection = await mysql.createConnection({
                host: dbConfig.host,
                user: dbConfig.user,
                database: dbConfig.database,
                password: dbConfig.password,
            });
        }
        return connection;
    }

    // Herramienta: ejecutar consultas SELECT
    server.registerTool(
        "query",
        {
            title: "Ejecutar consulta SELECT en MySQL",
            description: "Ejecuta una consulta SQL SELECT en la base de datos MySQL",
            inputSchema: {
                sql: z
                    .string()
                    .describe("Consulta SQL SELECT a ejecutar"),
            },
        },
        async ({ sql }) => {
            const sqlText = String(sql ?? "");
            if (!sqlText.trim().toUpperCase().startsWith("SELECT")) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: Solo se permiten consultas SELECT por seguridad",
                        },
                    ],
                    isError: true as const,
                };
            }

            const conn = await getConnection();
            const [rows] = await conn.execute(sqlText);
            const output = { rows };

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(rows, null, 2),
                    },
                ],
                structuredContent: output,
            };
        }
    );

    // Herramienta: listar tablas
    server.registerTool(
        "list_tables",
        {
            title: "Listar tablas de MySQL",
            description: "Lista todas las tablas disponibles en la base de datos",
            inputSchema: {},
        },
        async () => {
            const conn = await getConnection();
            const [tables] = await conn.execute("SHOW TABLES");
            const output = { tables };

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(tables, null, 2),
                    },
                ],
                structuredContent: output,
            };
        }
    );

    // Herramienta: describir tabla
    server.registerTool(
        "describe_table",
        {
            title: "Describir tabla de MySQL",
            description: "Describe la estructura de una tabla específica",
            inputSchema: {
                table: z
                    .string()
                    .describe("Nombre de la tabla a describir"),
            },
        },
        async ({ table }) => {
            const tableName = String(table ?? "").trim();
            if (!tableName) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Error: Debes indicar el nombre de la tabla",
                        },
                    ],
                    isError: true as const,
                };
            }

            const conn = await getConnection();
            const [columns] = await conn.execute(`DESCRIBE \`${tableName}\``);
            const output = { columns };

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify(columns, null, 2),
                    },
                ],
                structuredContent: output,
            };
        }
    );

    // Smithery espera que devolvamos el objeto MCP server subyacente
    return server.server;
}
