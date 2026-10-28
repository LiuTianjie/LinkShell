import { accountErrorMessage, type AccountErrorCode } from "../../../client-core/src/account-errors.js";

/**
 * A sign-in that did not finish, with a message the desktop can show as is. Kept apart from the
 * sign-in code so callers (and their tests) can recognise one without loading the network code.
 */
export class LoginError extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(accountErrorMessage(code));
    this.name = "LoginError";
  }
}
