import { loadConfig } from "./config.js";
import { createServerApp } from "./runtime.js";

const config = loadConfig();

let app;
try {
  app = createServerApp(config);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

app.listen(config.port, () => {
  console.log(
    `GoCourt voice tools listening on ${config.port} (${config.mock ? "mock GoCourt" : "live GoCourt"})`,
  );
});
