#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ErrorCode,
    McpError
} from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";

// Configuración de conexión desde variables de entorno
const getDbConfig = () => ({
    host: process.env.MYSQL_HOST || "localhost",
    user: process.env.MYSQL_USER || "root",
    database: process.env.MYSQL_DATABASE || "",
    password: process.env.MYSQL_PASSWORD || "",
    port: Number(process.env.MYSQL_PORT) || 3306
});

let connection: mysql.Connection | null = null;

// Función para conectar a MySQL
async function connectToMySQL() {
    if (!connection) {
        const config = getDbConfig();
        // Validar configuración mínima
        if (!config.database) {
             throw new Error("Falta definir la variable de entorno MYSQL_DATABASE");
        }

        try {
            connection = await mysql.createConnection(config);
            // Enviar log a stderr para no romper el protocolo stdio
            console.error(`✅ Conectado a MySQL en ${config.host}/${config.database}`);
        } catch (error) {
            console.error("❌ Error conectando a MySQL:", error);
            throw error;
        }
    }
    return connection;
}

// Crear servidor MCP
const server = new Server(
    {
        name: "pcpro-mcp-mysql",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Listar herramientas disponibles
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "query",
                description: "Ejecuta una consulta SQL SELECT en la base de datos MySQL",
                inputSchema: {
                    type: "object",
                    properties: {
                        sql: {
                            type: "string",
                            description: "Consulta SQL SELECT a ejecutar",
                        },
                    },
                    required: ["sql"],
                },
            },
            {
                name: "list_tables",
                description: "Lista todas las tablas disponibles en la base de datos",
                inputSchema: {
                    type: "object",
                    properties: {},
                },
            },
            {
                name: "describe_table",
                description: "Describe la estructura de una tabla específica",
                inputSchema: {
                    type: "object",
                    properties: {
                        table: {
                            type: "string",
                            description: "Nombre de la tabla a describir",
                        },
                    },
                    required: ["table"],
                },
            },
        ],
    };
});

// Manejar llamadas a herramientas
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const conn = await connectToMySQL();

        switch (request.params.name) {
            case "query": {
                const sql = String(request.params.arguments?.sql || "");

                // Validar que sea una consulta SELECT por seguridad
                if (!sql.trim().toUpperCase().startsWith("SELECT") && !sql.trim().toUpperCase().startsWith("SHOW")) {
                     throw new McpError(
                        ErrorCode.InvalidParams,
                        "Solo se permiten consultas SELECT o SHOW por seguridad"
                    );
                }

                const [rows] = await conn.execute(sql);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(rows, null, 2),
                        },
                    ],
                };
            }

            case "list_tables": {
                const [tables] = await conn.execute("SHOW TABLES");
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(tables, null, 2),
                        },
                    ],
                };
            }

            case "describe_table": {
                const table = String(request.params.arguments?.table || "");
                // Usar mysql.format para evitar inyección SQL básica en el nombre de la tabla
                const sql = mysql.format("DESCRIBE ??", [table]);
                const [columns] = await conn.execute(sql);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(columns, null, 2),
                        },
                    ],
                };
            }

            default:
                throw new McpError(
                    ErrorCode.MethodNotFound,
                    `Herramienta desconocida: ${request.params.name}`
                );
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Error ejecutando herramienta:", errorMessage);
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${errorMessage}`,
                },
            ],
            isError: true,
        };
    }
});

// Conectar transporte Stdio
async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("🚀 Servidor MCP MySQL (Stdio) listo");
}

runServer().catch((error) => {
    console.error("Error fatal iniciando servidor:", error);
    process.exit(1);
});
