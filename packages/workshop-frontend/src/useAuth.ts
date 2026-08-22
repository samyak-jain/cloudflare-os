import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { useServerConfig, useServerConfigError } from './ServerConfigContext'

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  source: 'access' | 'session' | null
  isLoading: boolean
  error: string | null
}

export function useAuth(
  publicApi: RpcStub<PublicApi>,
  accessAuthOverride?: boolean | null,
) {
  const serverConfig = useServerConfig()
  const serverConfigError = useServerConfigError()
  const accessAuthEnabled = accessAuthOverride === undefined
    ? (serverConfig?.accessAuthEnabled ?? (serverConfigError ? false : null))
    : accessAuthOverride
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    source: null,
    isLoading: true,
    error: null,
  })

  // Track current authenticated API stub for cleanup on unmount. State closures go stale in
  // cleanup functions, so this follows the currently committed stub.
  const authenticatedApiRef = useRef<RpcStub<AuthenticatedApi> | null>(null)
  authenticatedApiRef.current = authState.authenticatedApi

  // A connection bootstrap can overlap an inline login, logout, reconnect, or StrictMode effect
  // restart. Only the newest attempt may commit a capability or mutate the stored token.
  const authAttemptRef = useRef(0)

  /**
   * Names the signed-in user on error reports, for as long as this stub is the current one.
   *
   * Keyed on the stub rather than called from each authenticate path, so it covers however the
   * session was established — stored token, inline login, or Access. Nothing is cleared on effect
   * cleanup because two hook instances can coexist; explicit logout is the identity boundary.
   */
  useEffect(() => {
    const authenticatedApi = authState.authenticatedApi
    if (!authenticatedApi) return
    let cancelled = false
    authenticatedApi.whoami().then((info) => {
      if (!cancelled && info.type === 'user') setReportedUserId(info.id)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authState.authenticatedApi])

  useEffect(() => {
    const attempt = ++authAttemptRef.current
    const isCurrent = () => authAttemptRef.current === attempt

    const authenticateOnLoad = async () => {
      setAuthState(prev => {
        prev.authenticatedApi?.[Symbol.dispose]()
        return { token: null, authenticatedApi: null, source: null, isLoading: true, error: null }
      })

      const storedToken = localStorage.getItem('authToken')
      if (storedToken) {
        let sessionApi: RpcStub<AuthenticatedApi> | undefined
        try {
          sessionApi = await publicApi.authenticate(storedToken)
          if (!isCurrent()) {
            sessionApi[Symbol.dispose]()
            return
          }
          setAuthState({
            token: storedToken,
            authenticatedApi: sessionApi,
            source: 'session',
            isLoading: false,
            error: null,
          })
          return
        } catch {
          sessionApi?.[Symbol.dispose]()
          if (isCurrent()) localStorage.removeItem('authToken')
        }
      }

      if (!isCurrent() || accessAuthEnabled === null) return

      // A stored session stays on the original pipelined fast path above. Without one, the same
      // bundle attempts Access only when getServerConfig() says the deployment enabled it, so
      // ordinary/local deployments pay no guaranteed-failing authentication round trip.
      if (accessAuthEnabled) {
        let accessApi: RpcStub<AuthenticatedApi> | undefined
        try {
          // Await the capability-producing call itself so an expected auth rejection is handled
          // once (a rejected pipelined future can otherwise surface independently).
          accessApi = await publicApi.authenticateFromCfAccess()
          if (!isCurrent()) {
            accessApi[Symbol.dispose]()
            return
          }
          setAuthState({
            token: null,
            authenticatedApi: accessApi,
            source: 'access',
            isLoading: false,
            error: null,
          })
          return
        } catch {
          accessApi?.[Symbol.dispose]()
        }
      }

      if (isCurrent()) {
        setAuthState({
          token: null,
          authenticatedApi: null,
          source: null,
          isLoading: false,
          error: null,
        })
      }
    }

    void authenticateOnLoad()
    return () => {
      if (isCurrent()) authAttemptRef.current++
      authenticatedApiRef.current?.[Symbol.dispose]()
    }
  }, [accessAuthEnabled, publicApi])

  const authenticateWithToken = (token: string) => {
    authAttemptRef.current++
    setAuthState(prev => {
      prev.authenticatedApi?.[Symbol.dispose]()
      return {
        ...prev,
        authenticatedApi: null,
        source: null,
        isLoading: true,
        error: null,
      }
    })

    // Existing interactive login keeps promise pipelining: its caller just received this token
    // from login/createAccount, so the RPC already proved the credentials before returning it.
    const authenticatedApi = publicApi.authenticate(token)
    setAuthState({
      token,
      authenticatedApi,
      source: 'session',
      isLoading: false,
      error: null,
    })
  }

  const login = (token: string) => {
    authenticateWithToken(token)
  }

  const logout = () => {
    authAttemptRef.current++
    setReportedUserId(undefined)
    localStorage.removeItem('authToken')

    if (authState.source === 'access') {
      window.location.assign('/cdn-cgi/access/logout')
      return
    }

    setAuthState(prev => {
      prev.authenticatedApi?.[Symbol.dispose]()
      return {
        token: null,
        authenticatedApi: null,
        source: null,
        isLoading: false,
        error: null,
      }
    })
  }

  return {
    ...authState,
    login,
    logout,
    isAuthenticated: !!authState.authenticatedApi,
  }
}
