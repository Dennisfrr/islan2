export const API_BASE_URL: string = (import.meta as any)?.env?.VITE_API_BASE_URL || ''

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = input.startsWith('http') ? input : `${API_BASE_URL}${input}`
  return fetch(url, init)
}


