#![no_std]
extern crate alloc;
use alloc::{collections::BTreeMap, string::String};
use sails_rs::prelude::*;

// ── State ────────────────────────────────────────────────────────────────────

struct BridgeState {
    admin:       ActorId,
    relay:       ActorId,
    fee_planks:  u128,
    next_id:     u64,
    pending:     BTreeMap<u64, PendingRequest>,
}

struct PendingRequest {
    caller:     ActorId,
    payload:    String,
    value_paid: u128,
}

static mut STATE: Option<BridgeState> = None;

fn state() -> &'static BridgeState {
    unsafe { STATE.as_ref().expect("state not initialized") }
}

fn state_mut() -> &'static mut BridgeState {
    unsafe { STATE.as_mut().expect("state not initialized") }
}

// ── Events ───────────────────────────────────────────────────────────────────

#[event]
#[derive(Encode, TypeInfo, ReflectHash, Clone)]
#[codec(crate = sails_rs::scale_codec)]
#[type_info(crate = sails_rs::type_info)]
#[reflect_hash(crate = sails_rs::sails_reflect_hash)]
pub enum BridgeEvent {
    RequestPending {
        id:      u64,
        caller:  ActorId,
        payload: String,
    },
    RequestFulfilled {
        id: u64,
    },
}

// ── Service ──────────────────────────────────────────────────────────────────

pub struct BridgeService(());

impl BridgeService {
    pub fn new() -> Self {
        Self(())
    }
}

#[service(events = BridgeEvent)]
impl BridgeService {
    /// Submit a DeFi query. Returns the assigned request ID; result delivered later via msg::send.
    #[export]
    pub fn request_data(&mut self, payload: String) -> Result<u64, String> {
        let value = gstd::msg::value();
        let s = state_mut();

        if value < s.fee_planks {
            gstd::msg::send_bytes(gstd::msg::source(), &[], value)
                .map_err(|e| alloc::format!("refund failed: {:?}", e))?;
            return Err(alloc::format!("insufficient fee: sent {} planks, required {}", value, s.fee_planks));
        }

        let id = s.next_id;
        s.next_id += 1;

        let caller = gstd::msg::source();
        s.pending.insert(
            id,
            PendingRequest { caller, payload: payload.clone(), value_paid: value },
        );

        self.emitter()
            .emit_event(BridgeEvent::RequestPending { id, caller, payload })
            .expect("emit event");

        Ok(id)
    }

    /// Deliver a Skopos result back on-chain. Caller must be the relay wallet.
    #[export]
    pub fn fulfill_request(&mut self, id: u64, result: String) -> Result<(), String> {
        let s = state_mut();

        if gstd::msg::source() != s.relay {
            return Err("unauthorized: caller is not relay wallet".into());
        }

        let pending = s.pending.remove(&id).ok_or("request not found")?;

        gstd::msg::send_bytes(pending.caller, result.as_bytes(), 0)
            .map_err(|e| alloc::format!("send failed: {:?}", e))?;

        self.emitter()
            .emit_event(BridgeEvent::RequestFulfilled { id })
            .expect("emit event");

        Ok(())
    }

    /// View — relay queries before re-submitting to avoid duplicate fulfillments.
    #[export]
    pub fn query_pending(&self, id: u64) -> Option<String> {
        state().pending.get(&id).map(|r| r.payload.clone())
    }

    /// View — relay wallet ActorId.
    #[export]
    pub fn relay(&self) -> ActorId {
        state().relay
    }

    /// View — next request ID.
    #[export]
    pub fn next_id(&self) -> u64 {
        state().next_id
    }

    /// View — current fee in planks.
    #[export]
    pub fn fee_planks(&self) -> u128 {
        state().fee_planks
    }

    /// Admin — update minimum query fee.
    #[export]
    pub fn set_fee(&mut self, fee: u128) -> Result<(), String> {
        if gstd::msg::source() != state().admin {
            return Err("unauthorized".into());
        }
        state_mut().fee_planks = fee;
        Ok(())
    }

    /// Admin — update relay wallet address.
    #[export]
    pub fn set_relay(&mut self, new_relay: ActorId) -> Result<(), String> {
        if gstd::msg::source() != state().admin {
            return Err("unauthorized".into());
        }
        state_mut().relay = new_relay;
        Ok(())
    }

    /// Admin — withdraw collected fees from program.
    #[export]
    pub fn withdraw(&mut self, amount: u128) -> Result<(), String> {
        if gstd::msg::source() != state().admin {
            return Err("unauthorized".into());
        }
        gstd::msg::send_bytes(state().admin, &[], amount)
            .map_err(|e| alloc::format!("withdraw failed: {:?}", e))?;
        Ok(())
    }
}

// ── Program ──────────────────────────────────────────────────────────────────

pub struct BridgeProgram;

#[program]
impl BridgeProgram {
    /// Initialize bridge. Pass fee_planks=0 for local development.
    pub fn new(admin: ActorId, relay: ActorId, fee_planks: u128) -> Self {
        unsafe {
            STATE = Some(BridgeState {
                admin,
                relay,
                fee_planks,
                next_id: 0,
                pending: BTreeMap::new(),
            });
        }
        Self
    }

    pub fn bridge(&self) -> BridgeService {
        BridgeService::new()
    }
}
