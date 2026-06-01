"use strict";
// Pure JSDoc typedef module. Empty runtime export; the @typedefs feed the typecheck gate.

/**
 * @typedef {Object} FileRef
 * @property {string} [path]
 * @property {string} [dir]
 * @property {string} [file_id]
 * @property {string} [file_url]
 * @property {("auto"|"inline"|"upload")} [mode]
 */

/**
 * @typedef {Object} DelegationRequest
 * @property {string}  prompt
 * @property {string}  [developerInstructions]
 * @property {string}  [cwd]
 * @property {FileRef[]} [files]
 * @property {("low"|"medium"|"high"|"none")} [reasoningEffort]
 * @property {number}  [temperature]
 * @property {number}  [timeoutMs]
 * @property {string}  [threadId]
 * @property {string}  [expert]
 * @property {string}  [model]
 * @property {string}  [apiKey]  per-request provider key override; when set, a provider
 *   prefers it over its `process.env` key. The seam a remote/multi-tenant adapter injects
 *   per request (Phase 3). Unset in the stdio path - providers fall back to `process.env`.
 *   Phase-3 note: when this is used for real multi-tenancy, the remote adapter must also
 *   scope any per-thread session state (e.g. the openai-compatible `threadId` map) by tenant,
 *   so a reused threadId cannot resume another tenant's context under a different key.
 */

/**
 * @typedef {Object} DelegationSuccess
 * @property {false}    isError
 * @property {string}   provider
 * @property {string}   model
 * @property {string}   text
 * @property {string}   [threadId]
 * @property {number}   ms
 */

/**
 * @typedef {Object} DelegationError
 * @property {true}     isError
 * @property {string}   provider
 * @property {string}   model
 * @property {string}   errorKind
 * @property {boolean}  retryable
 * @property {string}   [message]
 * @property {number}   ms
 */

/** @typedef {DelegationSuccess | DelegationError} DelegationResult */

/**
 * @typedef {Object} ProviderCapabilities
 * @property {boolean} canImplement
 * @property {boolean} fileUpload
 * @property {boolean} multiTurn
 */

/**
 * @typedef {Object} Provider
 * @property {string} name
 * @property {ProviderCapabilities} capabilities
 * @property {() => Promise<{ok:boolean, reason?:string}>} health
 * @property {(req: DelegationRequest) => Promise<DelegationResult>} ask
 */

module.exports = {};
