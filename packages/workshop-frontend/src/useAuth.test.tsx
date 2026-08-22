// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi, AiChatAuthorInfo, ServerConfig } from '@gadgets/workshop-shared/api'
import { setReportedUserId } from './errorReporting'
import { ServerConfigContext } from './ServerConfigContext'
import { useAuth } from './useAuth'

vi.mock('./errorReporting', () => ({
  setReportedUserId: vi.fn<(reportedUserId: string | undefined) => void>(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const person: AiChatAuthorInfo = { type: 'user', id: 'person@example.com', name: 'Person' }
const serverConfig: ServerConfig = {
  accessAuthEnabled: false,
  authVendors: [],
  passwordAuthEnabled: true,
  cloudflareLimitsEnabled: false,
  signupsEnabled: true,
  siteName: '',
  announcement: '',
  banner: '',
  bannerColor: 'neutral',
  accentColor: '',
}
const accessServerConfig: ServerConfig = {
  ...serverConfig,
  accessAuthEnabled: true,
  passwordAuthEnabled: false,
}

/** A public API with optional ordinary-session and Access identities. */
function stubPublicApi(
  author?: AiChatAuthorInfo,
  accessAuthor?: AiChatAuthorInfo,
): RpcStub<PublicApi> {
  const stubFor = (identity?: AiChatAuthorInfo) => ({
    whoami: async () => {
      if (!identity) throw new Error('not authenticated')
      return identity
    },
    amIAdmin: async () => false,
    [Symbol.dispose]: () => {},
  })
  return {
    authenticate: () => {
      if (!author) throw new Error('not authenticated')
      return stubFor(author)
    },
    authenticateFromCfAccess: () => {
      if (!accessAuthor) throw new Error('Access is off')
      return stubFor(accessAuthor)
    },
  } as unknown as RpcStub<PublicApi>
}

/**
 * A public API whose `whoami` stays pending until released, for the window in which an answer can
 * arrive after a logout or a newer authentication has superseded it.
 *
 * Each authentication gets its own deferred, so `release(nth, ...)` can answer an earlier lookup
 * after a later one — the ordering a shared promise could not express.
 */
function deferredPublicApi(): {
  api: RpcStub<PublicApi>
  release: (nth: number, author: AiChatAuthorInfo) => void
} {
  const releases: ((author: AiChatAuthorInfo) => void)[] = []
  const authenticate = () => {
    let release: (author: AiChatAuthorInfo) => void = () => {}
    const pending = new Promise<AiChatAuthorInfo>((resolve) => { release = resolve })
    releases.push(release)
    return { whoami: () => pending, [Symbol.dispose]: () => {} }
  }
  return {
    api: {
      authenticate,
      authenticateFromCfAccess: () => { throw new Error('Access is off') },
    } as unknown as RpcStub<PublicApi>,
    release: (nth, author) => releases[nth](author),
  }
}

type Controls = { login: (token: string) => void; logout: () => void }

describe('useAuth error reporting identity', () => {
  const roots: Root[] = []
  const containers: HTMLDivElement[] = []

  afterEach(() => {
    act(() => roots.forEach(root => root.unmount()))
    vi.useRealTimers()
    roots.length = 0
    containers.forEach(container => container.remove())
    containers.length = 0
    localStorage.clear()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  /** Mounts an independent `useAuth` instance through the real server-config context wiring. */
  async function mount(
    publicApi: RpcStub<PublicApi>,
    config: ServerConfig | null = serverConfig,
  ): Promise<{
    controls: Controls
    root: Root
    authState: () => Pick<ReturnType<typeof useAuth>, 'isLoading' | 'error'>
  }> {
    const captured: {
      controls?: Controls
      authState?: Pick<ReturnType<typeof useAuth>, 'isLoading' | 'error'>
    } = {}
    function Consumer() {
      const { login, logout, isLoading, error } = useAuth(publicApi)
      captured.controls = { login, logout }
      captured.authState = { isLoading, error }
      return null
    }

    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(
      <ServerConfigContext.Provider value={config}>
        <Consumer />
      </ServerConfigContext.Provider>,
    ))
    return { controls: captured.controls!, root, authState: () => captured.authState! }
  }

  it('names the user when a stored token authenticates on mount', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi(person))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user after an inline login with no provider mounted', async () => {
    // The public blueprint page renders outside AuthProvider and logs in through its own useAuth
    // instance. Attaching identity in the provider left that whole session reporting anonymously.
    const { controls } = await mount(stubPublicApi(person))
    expect(setReportedUserId).not.toHaveBeenCalled()

    await act(async () => controls.login('fresh-token'))

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('names the user when Access authenticates without an app token', async () => {
    await mount(stubPublicApi(undefined, person), accessServerConfig)

    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('makes Access take precedence and purges a stale stored app session', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const authenticate = vi.fn<() => void>()
    const authenticateFromCfAccess = vi.fn<() => object>(() => ({
      whoami: async () => person,
      [Symbol.dispose]: () => {},
    }))
    const api = {
      authenticateFromCfAccess,
      authenticate,
    } as unknown as RpcStub<PublicApi>

    await mount(api, accessServerConfig)

    expect(authenticateFromCfAccess).toHaveBeenCalledOnce()
    expect(authenticate).not.toHaveBeenCalled()
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('uses only the Access identity when both identity sources are available', async () => {
    const calls: string[] = []
    localStorage.setItem('authToken', 'stored-token')
    const api = {
      authenticateFromCfAccess: () => {
        calls.push('access')
        return {
          whoami: async () => person,
          [Symbol.dispose]: () => {},
        }
      },
      authenticate: () => {
        calls.push('session')
        return {
          whoami: async () => ({ ...person, id: 'stale@example.com' }),
          [Symbol.dispose]: () => {},
        }
      },
    } as unknown as RpcStub<PublicApi>

    await mount(api, accessServerConfig)

    expect(calls).toEqual(['access'])
    expect(setReportedUserId).toHaveBeenCalledExactlyOnceWith('person@example.com')
  })

  it('falls back to the signed-out state when Access is unavailable', async () => {
    await mount(stubPublicApi(), accessServerConfig)

    expect(setReportedUserId).not.toHaveBeenCalled()
    expect(localStorage.getItem('authToken')).toBeNull()
  })

  it('does not call the Access RPC when the server reports the feature off', async () => {
    const authenticateFromCfAccess = vi.fn<() => never>(() => {
      throw new Error('must not be called')
    })
    const api = { authenticateFromCfAccess } as unknown as RpcStub<PublicApi>

    await mount(api)

    expect(authenticateFromCfAccess).not.toHaveBeenCalled()
  })

  it('stops loading if server configuration never settles', async () => {
    vi.useFakeTimers()
    const { authState } = await mount(stubPublicApi(), null)

    expect(authState()).toMatchObject({ isLoading: true, error: null })
    await act(async () => vi.advanceTimersByTime(10_000))

    expect(authState()).toMatchObject({
      isLoading: false,
      error: 'Authentication configuration timed out.',
    })
  })

  it('keeps the identity when one instance unmounts while another stays mounted', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const api = stubPublicApi(person)
    await mount(api)
    const { root: inner } = await mount(api)

    // The blueprint page nests its own instance inside the root's. Clearing on unmount would let
    // navigating away from that page blank an identity the root still holds.
    act(() => inner.unmount())
    roots.splice(roots.indexOf(inner), 1)

    expect(setReportedUserId).not.toHaveBeenCalledWith(undefined)
  })

  it('clears the identity on logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { controls } = await mount(stubPublicApi(person))

    act(() => controls.logout())

    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('ignores a lookup that resolves after logout', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)

    act(() => controls.logout())
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)

    // Disposing the stub is not a defence: capnweb does not guarantee that disposal rejects a call
    // already in flight, so a slow lookup could otherwise name a user who has just signed out.
    await act(async () => release(0, person))

    expect(setReportedUserId).not.toHaveBeenCalledWith('person@example.com')
    expect(setReportedUserId).toHaveBeenLastCalledWith(undefined)
  })

  it('ignores a lookup superseded by a newer authentication', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { api, release } = deferredPublicApi()
    const { controls } = await mount(api)
    await act(async () => controls.login('fresh-token'))

    // The newer authentication supersedes the first lookup, so answering that one last must not let
    // it win. Only the generation distinguishes them; arrival order alone would pick the stale id.
    await act(async () => release(0, { ...person, id: 'stale@example.com' }))
    expect(setReportedUserId).not.toHaveBeenCalledWith('stale@example.com')

    await act(async () => release(1, person))
    expect(setReportedUserId).toHaveBeenLastCalledWith('person@example.com')
  })

  it('does not name a person for an author that is not a user account', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi({ type: 'agent', id: 'gpt-5.1-pro', name: 'GPT' }))

    expect(setReportedUserId).not.toHaveBeenCalled()
  })

  it('names nobody when the identity lookup fails', async () => {
    localStorage.setItem('authToken', 'stored-token')
    await mount(stubPublicApi())

    expect(setReportedUserId).not.toHaveBeenCalled()
  })
})
