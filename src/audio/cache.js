import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('cache');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Cache chave/valor em JSON, com expiracao por entrada e limite por LRU.
 *
 * Grava com debounce e troca atomica (escreve em .tmp e renomeia), para uma
 * queda no meio da escrita nao deixar um JSON pela metade — que na proxima
 * inicializacao seria lido como cache corrompido.
 */
export class JsonCache {
  #file;
  #maxEntries;
  #entries = new Map();
  #loadPromise = null;
  #flushTimer = null;
  #dirty = false;

  constructor({ file, maxEntries = 2000 }) {
    this.#file = file;
    this.#maxEntries = maxEntries;
  }

  get size() {
    return this.#entries.size;
  }

  /** Carrega do disco uma unica vez, mesmo chamado de varios lugares. */
  async ready() {
    this.#loadPromise ??= this.#load();
    return this.#loadPromise;
  }

  async #load() {
    try {
      const raw = JSON.parse(await readFile(this.#file, 'utf8'));
      for (const [key, entry] of Object.entries(raw)) this.#entries.set(key, entry);
      log.debug(`${this.#entries.size} entradas carregadas de ${this.#file}`);
    } catch (err) {
      // Cache e descartavel: qualquer problema so significa comecar do zero.
      if (err.code !== 'ENOENT') log.warn(`cache ilegivel, comecando vazio: ${err.message}`);
    }
  }

  get(key) {
    const entry = this.#entries.get(key);
    if (!entry) return null;

    if (entry.exp && Date.now() > entry.exp) {
      this.delete(key);
      return null;
    }

    // Marca uso para o LRU, mas sem sujar o arquivo: leitura nao gera escrita.
    entry.t = Date.now();
    return entry.v;
  }

  set(key, value, { expiresAt = null } = {}) {
    this.#entries.set(key, { v: value, t: Date.now(), ...(expiresAt ? { exp: expiresAt } : {}) });
    this.#evict();
    this.#scheduleFlush();
  }

  delete(key) {
    if (this.#entries.delete(key)) this.#scheduleFlush();
  }

  clear() {
    this.#entries.clear();
    this.#scheduleFlush();
  }

  #evict() {
    const excess = this.#entries.size - this.#maxEntries;
    if (excess <= 0) return;

    const byLeastRecentlyUsed = [...this.#entries.entries()].sort((a, b) => a[1].t - b[1].t);
    for (const [key] of byLeastRecentlyUsed.slice(0, excess)) this.#entries.delete(key);
    log.debug(`${excess} entradas descartadas por limite`);
  }

  #scheduleFlush() {
    this.#dirty = true;
    if (this.#flushTimer) return;

    this.#flushTimer = setTimeout(() => void this.flush(), 2000);
    // Nao pode segurar o processo vivo no encerramento.
    this.#flushTimer.unref();
  }

  async flush() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (!this.#dirty) return;
    this.#dirty = false;

    try {
      await mkdir(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.#entries)));
      await rename(tmp, this.#file);
    } catch (err) {
      log.warn(`nao consegui gravar o cache: ${err.message}`);
    }
  }
}

export const resolveCache = new JsonCache({ file: path.join(ROOT, 'cache', 'resolve.json') });
