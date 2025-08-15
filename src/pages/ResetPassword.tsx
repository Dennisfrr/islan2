import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

export default function ResetPassword() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const type = params.get('type')

  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  if (type !== 'recovery') {
    return <div className="min-h-screen flex items-center justify-center">Link inválido ou expirado.</div>
  }

  const handleUpdate = async () => {
    if (!password) return
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) alert(error.message)
    else navigate('/login')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Definir nova senha</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="pwd">Nova senha</Label>
            <Input id="pwd" type="password" value={password} onChange={e=>setPassword(e.target.value)} required />
          </div>
          <Button onClick={handleUpdate} disabled={loading || !password} className="w-full">
            {loading ? 'Salvando...' : 'Alterar senha'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
