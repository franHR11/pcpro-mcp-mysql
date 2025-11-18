export default {
  esbuild: {
    external: [
      "@smithery/sdk",
      "@smithery/sdk/server/stateful.js",
      "@smithery/sdk/server/stateless.js",
      "chalk",
    ],
    target: "node18",
    minify: true,
  },
};
