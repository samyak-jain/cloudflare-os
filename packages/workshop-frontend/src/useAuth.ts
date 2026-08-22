import { useState, useEffect, useRef } from 'react'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { useServerConfig, useServerConfigError } from './ServerConfigContext'

const AUTH_CONFIG_TIMEOUT_MS = 10_000

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  source: 'access' | 'session' | null
  isLoading: boolean
  error: string | null
}

export function useAuth(publicApi: RpcStub<PublicApi>) {
  const serverConfig = useServerConfig()
  const serverConfigError = useServerConfigError()
  const accessAuthEnabled = serverConfig?.accessAuthEnabled ?? null
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
    let configTimeout: ReturnType<typeof setTimeout> | undefined

    const authenticateOnLoad = async () => {
      setAuthState(prev => {
        prev.authenticatedApi?.[Symbol.dispose]()
        return { token: null, authenticatedApi: null, source: null, isLoading: true, error: null }
      })

      // Config is the trust decision that selects the only permitted identity source. Do not let a
      // pre-Access app session race or outrank the Access-verified email while that decision is
      // pending. A bounded wait avoids leaving the UI on a permanent spinner if config stalls.
      if (accessAuthEnabled === null) {
        if (serverConfigError) {
          if (isCurrent()) {
            setAuthState({
              token: null,
              authenticatedApi: null,
              source: null,
              isLoading: false,
              error: 'Unable to load authentication configuration.',
            })
          }
          return
        }
        configTimeout = setTimeout(() => {
          if (isCurrent()) {
            setAuthState({
              token: null,
              authenticatedApi: null,
              source: null,
              isLoading: false,
              error: 'Authentication configuration timed out.',
            })
          }
        }, AUTH_CONFIG_TIMEOUT_MS)
        return
      }

      if (accessAuthEnabled) {
        // A session minted before Access became authoritative must never survive as an alternate
        // identity on this origin. Access is the sole identity source for this deployment.
        localStorage.removeItem('authToken')
        let accessApi: RpcStub<AuthenticatedApi> | undefined
        try {
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
      } else {
        // Ordinary/local deployments keep the existing stored-session path and never make a
        // guaranteed-failing Access RPC.
        const storedToken = localStorage.getItem('authToken')
        let sessionApi: RpcStub<AuthenticatedApi> | undefined
        try {
          if (!storedToken) throw new Error('No stored session')
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
          if (storedToken && isCurrent()) localStorage.removeItem('authToken')
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
      if (configTimeout !== undefined) clearTimeout(configTimeout)
      if (isCurrent()) authAttemptRef.current++
      authenticatedApiRef.current?.[Symbol.dispose]()
    }
  }, [accessAuthEnabled, publicApi, serverConfigError])

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
