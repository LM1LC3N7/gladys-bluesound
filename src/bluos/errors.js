// -----------------------------------------------------------------------------
// The error of a request to a player. `code`:
//   network   no TCP answer (refused, unreachable, reset)
//   timeout   no answer in time (a long poll gets its own, longer deadline)
//   aborted   cancelled by the integration (stop, address change)
//   too_large the answer is over MAX_BYTES
//   redirect  the player answered 3xx (never followed)
//   status    HTTP status other than 200 (`status`)
//   answer    the XML is not what the request expects
//   refused   the player answered <error> (`message` is its text)
// `unreachable` tells the failures that make a player "offline".
// -----------------------------------------------------------------------------

export class BluosError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = 'BluosError';
    this.code = code;
    this.status = status;
  }

  get unreachable() {
    return this.code === 'network' || this.code === 'timeout';
  }
}
