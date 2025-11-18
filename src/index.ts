#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";

// Obtener configuración de variables de entorno
const config = {
    host: process.env.MYSQL_HOST || "localhost",
    user: process.env.MYSQL_USER || "root",
    database: process.env.MYSQL_DATABASE || "",
    password: process.env.MYSQL_PASSWORD || "",
};

let connection: mysql.Connection | null = null;

// Función para conectar a MySQL
async function connectToMySQL() {
    if (!connection) {
        try {
            connection = await mysql.createConnection(config);
            console.error("✅ Conectado a MySQL exitosamente");
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
        name: "mysql-mcp-server",
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
    const conn = await connectToMySQL();

    try {
        switch (request.params.name) {
            case "query": {
                const sql = String(request.params.arguments?.sql || "");

                // Validar que sea una consulta SELECT
                if (!sql.trim().toUpperCase().startsWith("SELECT")) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Error: Solo se permiten consultas SELECT por seguridad",
                            },
                        ],
                    };
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
                const [columns] = await conn.execute(`DESCRIBE ${table}`);
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
                return {
                    content: [
                        {
                            type: "text",
                            text: `Herramienta desconocida: ${request.params.name}`,
                        },
                    ],
                };
        }
    } catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
});

// Iniciar servidor
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Servidor MCP MySQL iniciado");
}

main().catch((error) => {
    console.error("Error fatal:", error);
    process.exit(1);
});