/*
 * @adonisjs/auth
 *
 * (c) AdonisJS
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import type { HttpContext } from '@adonisjs/core/http'
import { Exception, RuntimeException } from '@adonisjs/core/exceptions'
import type { EmitterLike } from '@adonisjs/core/types/events'

import debug from './debug.js'
import { RememberMeToken } from './remember_me_token.js'
import { E_INVALID_CREDENTIALS, E_UNAUTHORIZED_ACCESS } from '../../src/errors.js'
import type { AuthClientResponse, GuardContract } from '../../src/types.js'
import { GUARD_KNOWN_EVENTS, PROVIDER_REAL_USER } from '../../src/symbols.js'
import type {
  SessionGuardConfig,
  SessionGuardEvents,
  SessionUserProviderContract,
} from './types.js'

/**
 * Session guard is an implementation of the AuthGuard contract to authenticate
 * incoming HTTP requests using sessions.
 *
 * It also goes beyond to create login sessions for users and verify their
 * credentials.
 */
export class SessionGuard<UserProvider extends SessionUserProviderContract<unknown>>
  implements GuardContract<UserProvider[typeof PROVIDER_REAL_USER]>
{
  /**
   * Events emitted by the guard
   */
  declare [GUARD_KNOWN_EVENTS]: SessionGuardEvents<UserProvider[typeof PROVIDER_REAL_USER]>

  /**
   * A unique name for the guard. It is used for prefixing
   * session data and remember me cookies
   */
  #name: string

  /**
   * Reference to the current HTTP context
   */
  #ctx: HttpContext

  /**
   * Configuration
   */
  #config: SessionGuardConfig

  /**
   * Provider to lookup user details
   */
  #userProvider: UserProvider

  /**
   * Emitter to emit events
   */
  #emitter: EmitterLike<SessionGuardEvents<UserProvider[typeof PROVIDER_REAL_USER]>>

  /**
   * Driver name of the guard
   */
  driverName: 'session' = 'session'

  /**
   * Whether or not the authentication has been attempted
   * during the current request.
   */
  authenticationAttempted = false

  /**
   * Find if the user has been logged out during
   * the current request
   */
  isLoggedOut = false

  /**
   * A boolean to know if the current request has
   * been authenticated
   */
  isAuthenticated = false

  /**
   * A boolean to know if the current request is authenticated
   * using the "rememember_me" token.
   */
  viaRemember = false

  /**
   * Reference to an instance of the authenticated or logged-in
   * user. The value only exists after calling one of the
   * following methods.
   *
   * - login
   * - loginViaId
   * - attempt
   * - authenticate
   * - check
   *
   * You can use the "getUserOrFail" method to throw an exception if
   * the request is not authenticated.
   */
  user?: UserProvider[typeof PROVIDER_REAL_USER]

  /**
   * The key used to store the logged-in user id inside
   * session
   */
  get sessionKeyName() {
    return `auth_${this.#name}`
  }

  /**
   * The key used to store the remember me token cookie
   */
  get rememberMeKeyName() {
    return `remember_${this.#name}`
  }

  constructor(
    name: string,
    config: SessionGuardConfig,
    ctx: HttpContext,
    emitter: EmitterLike<SessionGuardEvents<UserProvider[typeof PROVIDER_REAL_USER]>>,
    userProvider: UserProvider
  ) {
    this.#name = name
    this.#ctx = ctx
    this.#config = config
    this.#emitter = emitter
    this.#userProvider = userProvider
    debug('instantiating "%s" guard, config %O', this.#name, this.#config)
  }

  /**
   * Returns the session instance for the given request,
   * ensuring the property exists
   */
  #getSession() {
    if (!('session' in this.#ctx)) {
      throw new RuntimeException(
        'Cannot authenticate user. Install and configure "@adonisjs/session" package'
      )
    }

    return this.#ctx.session
  }

  /**
   * Notifies about login failure and returns an exception
   * to end the login process.
   */
  #loginFailed() {
    const error = new E_INVALID_CREDENTIALS('Invalid user credentails', {
      guardDriverName: this.driverName,
    })

    this.#emitter.emit('session_auth:login_failed', {
      ctx: this.#ctx,
      guardName: this.#name,
      error,
    })

    return error
  }

  /**
   * Emits authentication failure and returns an exception
   * to end the authentication cycle.
   */
  #authenticationFailed(sessionId: string) {
    const error = new E_UNAUTHORIZED_ACCESS('Invalid or expired user session', {
      guardDriverName: this.driverName,
    })

    this.#emitter.emit('session_auth:authentication_failed', {
      ctx: this.#ctx,
      guardName: this.#name,
      error,
      sessionId,
    })

    return error
  }

  /**
   * Emits the authentication succeeded event and updates
   * the local state to reflect successful authentication
   */
  #authenticationSucceeded(sessionId: string, rememberMeToken?: RememberMeToken) {
    this.isAuthenticated = true
    this.isLoggedOut = false
    this.viaRemember = !!rememberMeToken

    this.#emitter.emit('session_auth:authentication_succeeded', {
      ctx: this.#ctx,
      guardName: this.#name,
      sessionId: sessionId,
      user: this.user,
      rememberMeToken,
    })
  }

  /**
   * Creates session for a given user by their user id.
   */
  #createSessionForUser(userId: string | number | BigInt) {
    const session = this.#getSession()
    session.put(this.sessionKeyName, userId)
    session.regenerate()
  }

  /**
   * Creates the remember me cookie
   */
  #createRememberMeCookie(value: string) {
    this.#ctx.response.encryptedCookie(this.rememberMeKeyName, value, {
      maxAge: this.#config.rememberMeTokenAge || '2years',
      httpOnly: true,
    })
  }

  /**
   * Recycles the remember me token by updating its timestamps
   * and hash within the database. We ensure to only recycle
   * when token is older than 1min from last update.
   */
  async #recycleRememberMeToken(token: RememberMeToken, rememberMeCookie: string) {
    /**
     * Updated at with buffer represents the token's last updated
     * at date + a buffer of 60 seconds to avoid race conditions
     * where two concurrent requests recycles the token.
     */
    const updatedAtWithBuffer = new Date(token.updatedAt)
    updatedAtWithBuffer.setSeconds(updatedAtWithBuffer.getSeconds() + 60)

    if (new Date() > updatedAtWithBuffer) {
      debug('recycling remember me token')
      token.refresh(this.#config.rememberMeTokenAge || '2years')
      await this.#userProvider.recycleRememberMeToken!(token)
      this.#createRememberMeCookie(token.value!.release())
    } else {
      this.#createRememberMeCookie(rememberMeCookie)
    }
  }

  /**
   * Authenticates the user using its id read from the session
   * store.
   *
   * - We check the user exists in the db
   * - If not, throw exception.
   * - Otherwise, update local state to mark the user as logged-in
   */
  async #authenticateViaId(loggedInUserId: string | number | BigInt, sessionId: string) {
    debug('authenticating user from session')

    /**
     * Check the user exists with the provider
     */
    const providerUser = await this.#userProvider.findById(loggedInUserId)
    if (!providerUser) {
      throw this.#authenticationFailed(sessionId)
    }

    debug('marking user with id "%s" as authenticated', providerUser.getId())

    this.user = providerUser.getOriginal()
    this.#authenticationSucceeded(sessionId)

    return this.user
  }

  /**
   * Authenticates user from the remember me cookie. Creates a fresh
   * session for them and recycles the remember me token as well.
   */
  async #authenticateViaRememberCookie(rememberMeCookie: string, sessionId: string) {
    debug('attempting to authenticate via rememberMeCookie')

    /**
     * Fail authentication when user provider does not implement
     * APIs needed to verify and recycle remember me tokens
     */
    if (
      !this.#userProvider.findRememberMeTokenBySeries ||
      !this.#userProvider.recycleRememberMeToken
    ) {
      throw this.#authenticationFailed(sessionId)
    }

    /**
     * Decode token or fail when unable to do so
     */
    const decodedToken = RememberMeToken.decode(rememberMeCookie)
    if (!decodedToken) {
      throw this.#authenticationFailed(sessionId)
    }

    /**
     * Search for token via provider and ensure token hash matches the
     * token value and guard are the same.
     *
     * We expect the provider to check for expired tokens, return null for
     * expired tokens and optionally delete them.
     */
    const token = await this.#userProvider.findRememberMeTokenBySeries(decodedToken.series)
    if (!token || !token.verify(decodedToken.value) || token.guard !== this.#name) {
      throw this.#authenticationFailed(sessionId)
    }

    debug('found valid remember me token')

    /**
     * Check if a user for the token exists. Otherwise abort
     * authentication
     */
    const providerUser = await this.#userProvider.findById(token.userId)
    if (!providerUser) {
      throw this.#authenticationFailed(sessionId)
    }

    /**
     * Create session
     */
    const userId = providerUser.getId()
    debug('marking user with id "%s" as logged in from remember me cookie', userId)
    this.#createSessionForUser(userId)

    /**
     * Emit event and update local state
     */
    debug('marking user with id "%s" as authenticated', userId)
    this.user = providerUser.getOriginal()
    this.#authenticationSucceeded(sessionId, token)

    await this.#recycleRememberMeToken(token, rememberMeCookie)
    return this.user
  }

  /**
   * Returns an instance of the authenticated user. Or throws
   * an exception if the request is not authenticated.
   */
  getUserOrFail(): UserProvider[typeof PROVIDER_REAL_USER] {
    if (!this.user) {
      throw new E_UNAUTHORIZED_ACCESS('Invalid or expired user session', {
        guardDriverName: this.driverName,
      })
    }

    return this.user
  }

  /**
   * Verifies user credentials and returns the user instance.
   * Under the uses the provider to find the user and
   * verify password.
   */
  async verifyCredentials(uid: string, password: string) {
    debug('attempting to verify credentials for uid "%s"', uid)

    /**
     * Attempt to verify credentials and raise error if they
     * are invalid
     */
    const providerUser = await this.#userProvider.verifyCredentials(uid, password)
    if (!providerUser) {
      throw this.#loginFailed()
    }

    const user = providerUser.getOriginal()

    /**
     * Notify credentials have been verified
     */
    this.#emitter.emit('session_auth:credentials_verified', {
      ctx: this.#ctx,
      guardName: this.#name,
      uid,
      user,
    })

    return user
  }

  /**
   * Attempt to login a user after verifying their
   * credentials.
   */
  async attempt(
    uid: string,
    password: string,
    remember?: boolean
  ): Promise<UserProvider[typeof PROVIDER_REAL_USER]> {
    const user = await this.verifyCredentials(uid, password)
    return this.login(user, remember)
  }

  /**
   * Login a user by user id. Queries the user using the user provider
   * and calls "login" method under the hood.
   */
  async loginViaId(userId: string | number | BigInt, remember: boolean = false) {
    debug('attempting to login user via id "%s"', userId)

    const providerUser = await this.#userProvider.findById(userId)
    if (!providerUser) {
      throw this.#loginFailed()
    }

    return this.login(providerUser.getOriginal(), remember)
  }

  /**
   * Login a user by setting the session state. Optionally you
   * can create the remember me cookie to have persistent
   * login even after the session expires.
   */
  async login(
    user: UserProvider[typeof PROVIDER_REAL_USER],
    remember: boolean = false
  ): Promise<UserProvider[typeof PROVIDER_REAL_USER]> {
    this.#emitter.emit('session_auth:login_attempted', {
      ctx: this.#ctx,
      user,
      guardName: this.#name,
    })

    /**
     * Creating the provider user we can use to pull the
     * user id
     */
    const session = this.#getSession()
    const providerUser = await this.#userProvider.createUserForGuard(user)
    const userId = providerUser.getId()

    /**
     * Create remember me token and persist it with the provider
     * when remember me token is true.
     */
    let token: RememberMeToken | undefined
    if (remember) {
      if (!this.#userProvider.createRememberMeToken) {
        throw new Exception(
          'Cannot use "rememberMe" feature. The provider does not implement the "createRememberMeToken" method'
        )
      }

      debug('creating remember me cookie')
      token = RememberMeToken.create(
        userId,
        this.#config.rememberMeTokenAge || '2years',
        this.#name
      )
      await this.#userProvider.createRememberMeToken(token)
      this.#createRememberMeCookie(token.value!.release())
    } else {
      this.#ctx.response.clearCookie(this.rememberMeKeyName)
    }

    /**
     * Create session
     */
    debug('marking user with id "%s" as logged-in', userId)
    this.#createSessionForUser(userId)

    /**
     * Update local state
     */
    this.user = user
    this.isLoggedOut = false

    /**
     * Notify login succeeded
     */
    this.#emitter.emit('session_auth:login_succeeded', {
      ctx: this.#ctx,
      guardName: this.#name,
      user,
      sessionId: session.sessionId,
    })

    return this.user
  }

  /**
   * Authenticates the current HTTP request by reading the userId
   * from the session and/or using the remember me token to have
   * persistent login.
   *
   * Calling this method multiple times results in a noop.
   */
  async authenticate(): Promise<UserProvider[typeof PROVIDER_REAL_USER]> {
    /**
     * Return early when authentication has already
     * been attempted
     */
    if (this.authenticationAttempted) {
      return this.getUserOrFail()
    }

    this.authenticationAttempted = true
    const session = this.#getSession()

    /**
     * Notify we are starting the authentication process
     */
    this.#emitter.emit('session_auth:authentication_attempted', {
      ctx: this.#ctx,
      guardName: this.#name,
      sessionId: session.sessionId,
    })

    /**
     * Check if there is a user id inside the session store.
     * If yes, fetch the user from the persistent storage
     * and mark them as logged-in
     */
    const loggedInUserId = session.get(this.sessionKeyName)
    if (loggedInUserId) {
      return this.#authenticateViaId(loggedInUserId, session.sessionId)
    }

    /**
     * If rememberMeCookie exists then attempt to authenticate via the
     * remember me cookie
     */
    const rememberMeCookie = this.#ctx.request.encryptedCookie(this.rememberMeKeyName)
    if (rememberMeCookie) {
      return this.#authenticateViaRememberCookie(rememberMeCookie, session.sessionId)
    }

    /**
     * Otherwise fail
     */
    throw this.#authenticationFailed(session.sessionId)
  }

  /**
   * Silently check if the user is authenticated or not, without
   * throwing any exceptions
   */
  async check(): Promise<boolean> {
    try {
      await this.authenticate()
      return true
    } catch (error) {
      if (error instanceof E_UNAUTHORIZED_ACCESS) {
        return false
      }

      throw error
    }
  }

  /**
   * Logout user and revoke remember me token (if any)
   */
  async logout() {
    debug('session_auth: logging out')
    const session = this.#getSession()
    const rememberMeCookie = this.#ctx.request.encryptedCookie(this.rememberMeKeyName)

    /**
     * Clear client side state
     */
    session.forget(this.sessionKeyName)
    this.#ctx.response.clearCookie(this.rememberMeKeyName)

    /**
     * Update local state
     */
    this.user = undefined
    this.viaRemember = false
    this.isAuthenticated = false
    this.isLoggedOut = true

    /**
     * Notify the user has been logged out
     */
    this.#emitter.emit('session_auth:logged_out', {
      ctx: this.#ctx,
      guardName: this.#name,
      user: this.user || null,
      sessionId: session.sessionId,
    })

    /**
     * Return early when there is no remember me cookie
     * or if the provider does not implement the method
     * to delete tokens
     */
    if (!rememberMeCookie || !this.#userProvider.deleteRememberMeTokenBySeries) {
      return
    }

    /**
     * Return early when remember me token is invalid
     */
    debug('session_auth: decoding remember me token')
    const decodedToken = RememberMeToken.decode(rememberMeCookie)
    if (!decodedToken) {
      return
    }

    /**
     * Delete the remember me token
     */
    debug('session_auth: deleting remember me token')
    await this.#userProvider.deleteRememberMeTokenBySeries(decodedToken.series)
  }

  /**
   * Returns the session info for the clients to send during
   * an HTTP request to mark the user as logged-in.
   */
  async authenticateAsClient(
    user: UserProvider[typeof PROVIDER_REAL_USER]
  ): Promise<AuthClientResponse> {
    const providerUser = await this.#userProvider.createUserForGuard(user)
    const userId = providerUser.getId()

    debug('session_guard: returning client session for user id "%s"', userId)
    return {
      session: {
        [this.sessionKeyName]: userId,
      },
    }
  }
}
