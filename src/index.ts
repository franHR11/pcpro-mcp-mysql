#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import express from "express";

// Puerto del servidor
const PORT = process.env.PORT || 3000;

// Crear aplicación Express
const app = express();
app.use(express.json());

// Endpoint de salud
app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
});

// Endpoint principal MCP
app.get("/mcp", async (req, res) => {
    // Obtener configuración de query parameters
    const config = {
        host: (req.query.mysqlHost as string) || process.env.MYSQL_HOST || "localhost",
        user: (req.query.mysqlUser as string) || process.env.MYSQL_USER || "root",
        database: (req.query.mysqlDatabase as string) || process.env.MYSQL_DATABASE || "",
        password: (req.query.mysqlPassword as string) || process.env.MYSQL_PASSWORD || "",
    };

    let connection: mysql.Connection | null = null;

    // Función para conectar a MySQL
    async function connectToMySQL() {
        if (!connection) {
            try {
                connection = await mysql.createConnection(config);
                console.log("✅ Conectado a MySQL exitosamente");
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

    // Crear transporte SSE para HTTP
    const transport = new SSEServerTransport("/message", res);
    await server.connect(transport);

    // Cleanup al cerrar conexión
    req.on("close", async () => {
        if (connection) {
            await connection.end();
        }
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor MCP MySQL escuchando en puerto ${PORT}`);
    console.log(`📡 Endpoint MCP: http://localhost:${PORT}/mcp`);
});