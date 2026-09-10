// SSH 公鑰共用工具：部署頁下拉與設定頁清單共用的類型標籤轉換

export interface SshPublicKeyOption {
  id: number
  label: string
  publicKey: string
  createdAt: string
}

// 公鑰首段為金鑰類型，換算為易讀名稱供介面顯示
const keyTypeLabels: Record<string, string> = {
  'ssh-ed25519': 'Ed25519',
  'ssh-rsa': 'RSA',
  'ecdsa-sha2-nistp256': 'ECDSA P-256',
  'ecdsa-sha2-nistp384': 'ECDSA P-384',
  'ecdsa-sha2-nistp521': 'ECDSA P-521',
  'sk-ssh-ed25519@openssh.com': 'FIDO2 Ed25519',
  'sk-ecdsa-sha2-nistp256@openssh.com': 'FIDO2 ECDSA',
}

export function sshKeyTypeLabel(publicKey: string) {
  const type = publicKey.trim().split(/\s+/)[0] || ''
  return keyTypeLabels[type] || type || '未知類型'
}
