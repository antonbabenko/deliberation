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
