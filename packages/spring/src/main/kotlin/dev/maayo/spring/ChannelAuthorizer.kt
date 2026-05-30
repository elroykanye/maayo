package dev.maayo.spring

import java.security.Principal

/**
 * Decides whether a principal may push to or pull from a given channel.
 *
 * Register a bean of this type to enforce RBAC-based channel gating.
 * The default implementation ([PermitAllChannelAuthorizer]) allows everything —
 * suitable for development; replace it in production.
 */
interface ChannelAuthorizer {
    fun canPush(principal: Principal?, channel: String): Boolean
    fun canPull(principal: Principal?, channel: String): Boolean
}

/** Open-door implementation — allows all push/pull. Replace in production. */
class PermitAllChannelAuthorizer : ChannelAuthorizer {
    override fun canPush(principal: Principal?, channel: String) = true
    override fun canPull(principal: Principal?, channel: String) = true
}
