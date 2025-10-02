#!/usr/bin/env node
"use strict";

// Simple CLI to purge all data from a Neo4j database in batches.
// Usage examples:
//   node clear-neo4j.js --uri bolt://localhost:7687 --user neo4j --password password --database neo4j
//   NEO4J_URI=bolt://localhost:7687 NEO4J_USERNAME=neo4j NEO4J_PASSWORD=password node clear-neo4j.js
// Optional flags:
//   --batch 5000        Batch size for deletion (default: 10000)
//   --database neo4j    Target database name (default: server default)
//   --dry-run           Only count nodes, do not delete

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (key === "dry-run") {
      args["dryRun"] = true;
      continue;
    }
    if (key === "uri" || key === "user" || key === "password" || key === "database" || key === "batch") {
      if (typeof next !== "string" || next.startsWith("--")) {
        throw new Error(`Flag --${key} requer um valor.`);
      }
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readConfig() {
  const args = parseArgs(process.argv);

  const config = {
    uri: args.uri || process.env.NEO4J_URI || process.env.NEO4J_URL,
    user: args.user || process.env.NEO4J_USERNAME || process.env.NEO4J_USER,
    password: args.password || process.env.NEO4J_PASSWORD,
    database: args.database || process.env.NEO4J_DATABASE || undefined,
    batchSize: Number(args.batch || process.env.BATCH_SIZE || 10000),
    dryRun: Boolean(args.dryRun || String(process.env.DRY_RUN).toLowerCase() === "true"),
  };

  const missing = [];
  if (!config.uri) missing.push("NEO4J_URI / --uri");
  if (!config.user) missing.push("NEO4J_USERNAME / --user");
  if (!config.password) missing.push("NEO4J_PASSWORD / --password");
  if (missing.length > 0) {
    console.error("Configuração ausente. Forneça:", missing.join(", "));
    console.error("Exemplo: node clear-neo4j.js --uri bolt://localhost:7687 --user neo4j --password senha");
    process.exit(1);
  }

  if (!Number.isFinite(config.batchSize) || config.batchSize <= 0) {
    console.error("--batch deve ser um número inteiro positivo.");
    process.exit(1);
  }

  return config;
}

function requireNeo4jDriver() {
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    return require("neo4j-driver");
  } catch (err) {
    console.error("Dependência 'neo4j-driver' não encontrada.");
    console.error("Instale com: npm install neo4j-driver");
    process.exit(1);
  }
}

async function countNodes(session) {
  const result = await session.run("MATCH (n) RETURN count(n) AS c");
  const record = result.records[0];
  return record ? record.get("c").toNumber?.() ?? Number(record.get("c")) : 0;
}

async function deleteBatch(session, limit) {
  const cypher = "MATCH (n) WITH n LIMIT $limit DETACH DELETE n RETURN count(n) AS deleted";
  const result = await session.run(cypher, { limit: Number(limit) });
  const record = result.records[0];
  return record ? record.get("deleted").toNumber?.() ?? Number(record.get("deleted")) : 0;
}

async function main() {
  const startTs = Date.now();
  const cfg = readConfig();
  const neo4j = requireNeo4jDriver();

  const driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password), {
    // Larger fetch size helps when counting large graphs
    fetchSize: 10000,
  });

  try {
    await driver.getServerInfo();
  } catch (err) {
    console.error("Falha ao conectar no Neo4j:", err.message || err);
    await driver.close();
    process.exit(1);
  }

  const session = cfg.database ? driver.session({ database: cfg.database, defaultAccessMode: neo4j.session.WRITE }) : driver.session({ defaultAccessMode: neo4j.session.WRITE });

  try {
    const totalBefore = await countNodes(session);
    console.log(`[Neo4j] Nós antes: ${totalBefore}`);

    if (cfg.dryRun) {
      console.log("--dry-run ativo. Nenhuma exclusão foi realizada.");
      return;
    }

    let deletedTotal = 0;
    while (true) {
      const deleted = await deleteBatch(session, cfg.batchSize);
      deletedTotal += deleted;
      if (deleted === 0) break;
      console.log(`Deletados no lote: ${deleted} (acumulado: ${deletedTotal})`);
    }

    const totalAfter = await countNodes(session);
    console.log(`[Neo4j] Nós após limpeza: ${totalAfter}`);

    const ms = Date.now() - startTs;
    console.log(`Concluído em ${ms} ms.`);
  } catch (err) {
    console.error("Erro durante a limpeza:", err.stack || err.message || err);
    process.exitCode = 1;
  } finally {
    await session.close();
    await driver.close();
  }
}

main();


