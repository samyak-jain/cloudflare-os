import { createFileRoute } from '@tanstack/react-router'
import { useRpcStub } from '../RpcContext'
import SignupPage from '../SignupPage'

export const Route = createFileRoute('/signup')({
  component: SignupRoute,
})

function SignupRoute() {
  const rpcStub = useRpcStub()
  return <SignupPage rpcStub={rpcStub} />
}
