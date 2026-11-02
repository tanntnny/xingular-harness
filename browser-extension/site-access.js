(() => {
  const originOf = address => {
    try {
      const url = new URL(address)
      return ['http:', 'https:'].includes(url.protocol) ? url.origin : null
    } catch {
      return null
    }
  }

  const permissionFor = address => {
    const origin = originOf(address)
    if (!origin) return null
    const url = new URL(origin)
    // Chrome host permissions do not scope to ports. The stored origin below does.
    return `${url.protocol}//${url.hostname}/*`
  }

  const savedOrigins = async api => {
    const saved = await api.storage.local.get('allowedOrigins')
    return Array.isArray(saved.allowedOrigins)
      ? [...new Set(saved.allowedOrigins.filter(origin => typeof origin === 'string' && originOf(origin) === origin))]
      : []
  }

  const allowed = async (address, api = chrome) => {
    const origin = originOf(address)
    const permission = permissionFor(address)
    if (!origin || !permission || !(await savedOrigins(api)).includes(origin)) return false
    return api.permissions.contains({ origins: [permission] })
  }

  const grant = async (address, api = chrome) => {
    const origin = originOf(address)
    const permission = permissionFor(address)
    if (!origin || !permission || !await api.permissions.request({ origins: [permission] })) return false
    const origins = await savedOrigins(api)
    if (!origins.includes(origin)) origins.push(origin)
    await api.storage.local.set({ allowedOrigins: origins })
    return true
  }

  const revoke = async (address, api = chrome) => {
    const origin = originOf(address)
    const permission = permissionFor(address)
    if (!origin || !permission) return
    const origins = (await savedOrigins(api)).filter(saved => saved !== origin)
    await api.storage.local.set({ allowedOrigins: origins })
    if (!origins.some(saved => permissionFor(saved) === permission)) {
      await api.permissions.remove({ origins: [permission] }).catch(() => false)
    }
  }

  const forgetRemoved = async (permissions, api = chrome) => {
    const removed = new Set(Array.isArray(permissions?.origins) ? permissions.origins : [])
    if (!removed.size) return
    const origins = await savedOrigins(api)
    const remaining = origins.filter(origin => !removed.has(permissionFor(origin)))
    if (remaining.length !== origins.length) await api.storage.local.set({ allowedOrigins: remaining })
  }

  globalThis.XingularSiteAccess = Object.freeze({ originOf, permissionFor, allowed, grant, revoke, forgetRemoved })
})()
