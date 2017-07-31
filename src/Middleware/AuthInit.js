'use strict'

/*
 * adonis-auth
 *
 * (c) Harminder Virk <virk@adonisjs.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
*/

class AuthInit {
  constructor (Config) {
    const authenticator = Config.get('auth.authenticator')
    this.scheme = Config.get(`auth.${authenticator}.scheme`)
  }

  /**
   * Check the user login status if scheme in use
   * in session. Since it will make the `user`
   * instance available on each request.
   *
   * @method handle
   *
   * @param  {Object}   options.auth
   * @param  {Function} next
   *
   * @return {void}
   */
  async handle ({ auth }, next) {
    if (this.scheme === 'session') {
      await auth.check()
    }
    await next()
  }
}

module.exports = AuthInit