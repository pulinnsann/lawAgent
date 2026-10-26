//! Cooperative resource admission for the experimental native backend.
//!
//! Reservations cover buffers and caches owned by participating native jobs. They
//! are estimates, not an OS RSS limit, and do not measure or control another
//! application's model. Callers must stream inputs, respect the declared bounds,
//! stop I/O on cancellation, and keep the permit for the lifetime of their buffers.
//! There is deliberately no pending-job queue in this module.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

const MIB: u64 = 1024 * 1024;
const MAX_NATIVE_BUDGET: u64 = 1024 * MIB;
const MAX_FILE_BUDGET: u64 = 1024 * MIB;
const MAX_PRIORITY_SCOPES: u16 = 16;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourcePolicy {
    pub native_budget_bytes: u64,
    /// Part of native_budget_bytes reserved exclusively for control operations.
    pub control_budget_bytes: u64,
    pub max_control_operation_bytes: u64,
    pub max_single_job_reservation_bytes: u64,
    pub max_file_bytes: u64,
    /// Cache bytes are included in a job's reservation, never added outside it.
    pub cache_budget_bytes: u64,
    pub max_query_chunks: u32,
    pub max_job_items: u32,
    pub max_model_requests: u16,
    pub max_heavy_jobs: u16,
    pub max_light_jobs: u16,
    pub max_control_jobs: u16,
}

impl Default for ResourcePolicy {
    fn default() -> Self {
        Self {
            native_budget_bytes: 64 * MIB,
            control_budget_bytes: 256 * 1024,
            max_control_operation_bytes: 32 * 1024,
            max_single_job_reservation_bytes: 16 * MIB,
            max_file_bytes: 16 * MIB,
            cache_budget_bytes: 8 * MIB,
            max_query_chunks: 24,
            max_job_items: 128,
            max_model_requests: 1,
            max_heavy_jobs: 1,
            max_light_jobs: 2,
            max_control_jobs: 4,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyError {
    pub field: &'static str,
    pub message: &'static str,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.field, self.message)
    }
}

impl std::error::Error for PolicyError {}

impl ResourcePolicy {
    pub fn validate(&self) -> Result<(), PolicyError> {
        let check = |valid, field, message| {
            if valid { Ok(()) } else { Err(PolicyError { field, message }) }
        };
        check((MIB..=MAX_NATIVE_BUDGET).contains(&self.native_budget_bytes),
            "nativeBudgetBytes", "must be between 1 MiB and 1 GiB")?;
        check(self.control_budget_bytes > 0 && self.control_budget_bytes < self.native_budget_bytes,
            "controlBudgetBytes", "must be positive and below the native budget")?;
        check(self.max_control_operation_bytes > 0 && self.max_control_operation_bytes <= self.control_budget_bytes,
            "maxControlOperationBytes", "must fit the control budget")?;
        check((1..=16).contains(&self.max_control_jobs), "maxControlJobs", "must be between 1 and 16")?;
        check(self.max_control_operation_bytes.checked_mul(u64::from(self.max_control_jobs))
                .is_some_and(|bytes| bytes <= self.control_budget_bytes),
            "controlBudgetBytes", "must reserve space for every admitted control operation")?;
        let work_budget = self.native_budget_bytes - self.control_budget_bytes;
        check(self.max_single_job_reservation_bytes > 0 && self.max_single_job_reservation_bytes <= work_budget,
            "maxSingleJobReservationBytes", "must be positive and fit the work budget")?;
        check((1..=MAX_FILE_BUDGET).contains(&self.max_file_bytes), "maxFileBytes", "must be between 1 byte and 1 GiB")?;
        check(self.cache_budget_bytes <= work_budget, "cacheBudgetBytes", "must fit the work budget")?;
        check((1..=1024).contains(&self.max_query_chunks), "maxQueryChunks", "must be between 1 and 1024")?;
        check((1..=65536).contains(&self.max_job_items), "maxJobItems", "must be between 1 and 65536")?;
        check((1..=4).contains(&self.max_model_requests), "maxModelRequests", "must be between 1 and 4")?;
        check((1..=2).contains(&self.max_heavy_jobs), "maxHeavyJobs", "must be between 1 and 2")?;
        check((1..=16).contains(&self.max_light_jobs), "maxLightJobs", "must be between 1 and 16")?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryPressure {
    #[default]
    Normal,
    Elevated,
    Critical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkKind {
    ModelRequest,
    Ocr,
    IndexRebuild,
    PdfConversion,
    ReportRendering,
    RetrievalQuery,
    ParseDocument,
    ReadSmallNativeState,
    Cancel,
}

impl WorkKind {
    pub fn is_heavy(self) -> bool {
        matches!(self, Self::Ocr | Self::IndexRebuild | Self::PdfConversion | Self::ReportRendering)
    }

    pub fn is_control(self) -> bool {
        matches!(self, Self::ReadSmallNativeState | Self::Cancel)
    }

}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkRequest {
    pub kind: WorkKind,
    pub reserved_bytes: u64,
    /// Size of a single input, when applicable. Zero means no input file.
    pub file_bytes: u64,
    pub cache_bytes: u64,
    pub query_chunks: u32,
    pub job_items: u32,
}

impl WorkRequest {
    pub fn new(kind: WorkKind, reserved_bytes: u64) -> Self {
        Self { kind, reserved_bytes, file_bytes: 0, cache_bytes: 0, query_chunks: 0, job_items: 1 }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum RequestError {
    ZeroReservation,
    ReservationTooLarge { requested: u64, limit: u64 },
    FileTooLarge { requested: u64, limit: u64 },
    CacheExceedsReservation,
    CacheTooLarge { requested: u64, limit: u64 },
    TooManyQueryChunks { requested: u32, limit: u32 },
    EmptyJob,
    TooManyJobItems { requested: u32, limit: u32 },
    /// Control requests must not smuggle file parsing, retrieval or cache work.
    InvalidControlWorkload,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum DeferReason {
    CriticalPressure,
    ElevatedPressure,
    LocalModelPriority,
    ModelWorkloadActive,
    HeavyWorkloadActive,
    ModelConcurrency,
    HeavyConcurrency,
    LightConcurrency,
    ControlConcurrency,
    MemoryBudget { requested: u64, available: u64 },
    CacheBudget { requested: u64, available: u64 },
}

/// Deferred requests are not retained. The caller may explicitly retry later.
#[derive(Debug)]
#[must_use = "handle admission; deferred and rejected work must not run"]
pub enum Admission {
    Granted(Permit),
    Deferred(DeferReason),
    Rejected(RequestError),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub pressure: MemoryPressure,
    pub local_model_priority_scopes: u16,
    pub active_model_requests: u16,
    pub active_heavy_jobs: u16,
    pub active_light_jobs: u16,
    pub active_control_jobs: u16,
    pub native_budget_bytes: u64,
    pub work_budget_bytes: u64,
    pub work_reserved_bytes: u64,
    pub control_reserved_bytes: u64,
    pub total_reserved_bytes: u64,
    pub cache_reserved_bytes: u64,
}

#[derive(Default)]
struct State {
    pressure: MemoryPressure,
    priority_scopes: u16,
    model: u16,
    heavy: u16,
    light: u16,
    control: u16,
    work_bytes: u64,
    control_bytes: u64,
    cache_bytes: u64,
}

struct Inner {
    policy: ResourcePolicy,
    state: Mutex<State>,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        // Job panics must not make cancellation or reservation release unusable.
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn work_budget(&self, pressure: MemoryPressure) -> u64 {
        let normal = self.policy.native_budget_bytes - self.policy.control_budget_bytes;
        match pressure {
            MemoryPressure::Normal => normal,
            MemoryPressure::Elevated => normal / 2,
            MemoryPressure::Critical => 0,
        }
    }
}

#[derive(Clone)]
pub struct ResourceGovernor {
    inner: Arc<Inner>,
}

impl ResourceGovernor {
    pub fn new(policy: ResourcePolicy) -> Result<Self, PolicyError> {
        policy.validate()?;
        Ok(Self { inner: Arc::new(Inner { policy, state: Mutex::new(State::default()) }) })
    }

    pub fn policy(&self) -> &ResourcePolicy {
        &self.inner.policy
    }

    /// Pressure is supplied by an external platform monitor or explicit user mode.
    /// This neither inspects a model process nor terminates existing operations.
    pub fn set_pressure(&self, pressure: MemoryPressure) {
        self.inner.lock().pressure = pressure;
    }

    /// Explicitly declare that the user wants resources left for a local model.
    /// This does not claim to discover models running in other applications.
    pub fn enter_local_model_priority(&self) -> Result<LocalModelPriorityGuard, PriorityScopeError> {
        let mut state = self.inner.lock();
        if state.priority_scopes >= MAX_PRIORITY_SCOPES {
            return Err(PriorityScopeError::TooManyScopes);
        }
        state.priority_scopes += 1;
        Ok(LocalModelPriorityGuard { inner: Some(Arc::clone(&self.inner)) })
    }

    pub fn snapshot(&self) -> ResourceSnapshot {
        let state = self.inner.lock();
        ResourceSnapshot {
            pressure: state.pressure,
            local_model_priority_scopes: state.priority_scopes,
            active_model_requests: state.model,
            active_heavy_jobs: state.heavy,
            active_light_jobs: state.light,
            active_control_jobs: state.control,
            native_budget_bytes: self.inner.policy.native_budget_bytes,
            work_budget_bytes: self.inner.work_budget(state.pressure),
            work_reserved_bytes: state.work_bytes,
            control_reserved_bytes: state.control_bytes,
            total_reserved_bytes: state.work_bytes + state.control_bytes,
            cache_reserved_bytes: state.cache_bytes,
        }
    }

    pub fn try_acquire(&self, request: WorkRequest) -> Admission {
        if let Err(error) = self.validate_request(&request) {
            return Admission::Rejected(error);
        }
        let policy = &self.inner.policy;
        let mut state = self.inner.lock();
        let kind = request.kind;

        if kind.is_control() {
            if state.control >= policy.max_control_jobs {
                return Admission::Deferred(DeferReason::ControlConcurrency);
            }
            let available = policy.control_budget_bytes.saturating_sub(state.control_bytes);
            if request.reserved_bytes > available {
                return Admission::Deferred(DeferReason::MemoryBudget { requested: request.reserved_bytes, available });
            }
            state.control += 1;
            state.control_bytes += request.reserved_bytes;
        } else {
            if state.pressure == MemoryPressure::Critical {
                return Admission::Deferred(DeferReason::CriticalPressure);
            }
            if kind.is_heavy() {
                if state.priority_scopes > 0 {
                    return Admission::Deferred(DeferReason::LocalModelPriority);
                }
                if state.pressure == MemoryPressure::Elevated {
                    return Admission::Deferred(DeferReason::ElevatedPressure);
                }
                if state.model > 0 {
                    return Admission::Deferred(DeferReason::ModelWorkloadActive);
                }
                if state.heavy >= policy.max_heavy_jobs {
                    return Admission::Deferred(DeferReason::HeavyConcurrency);
                }
            } else if kind == WorkKind::ModelRequest {
                if state.heavy > 0 {
                    return Admission::Deferred(DeferReason::HeavyWorkloadActive);
                }
                if state.model >= policy.max_model_requests {
                    return Admission::Deferred(DeferReason::ModelConcurrency);
                }
            } else if state.light >= policy.max_light_jobs {
                return Admission::Deferred(DeferReason::LightConcurrency);
            }
            let available = self.inner.work_budget(state.pressure).saturating_sub(state.work_bytes);
            if request.reserved_bytes > available {
                return Admission::Deferred(DeferReason::MemoryBudget { requested: request.reserved_bytes, available });
            }
            let available_cache = policy.cache_budget_bytes.saturating_sub(state.cache_bytes);
            if request.cache_bytes > available_cache {
                return Admission::Deferred(DeferReason::CacheBudget { requested: request.cache_bytes, available: available_cache });
            }
            if kind.is_heavy() { state.heavy += 1; }
            else if kind == WorkKind::ModelRequest { state.model += 1; }
            else { state.light += 1; }
            state.work_bytes += request.reserved_bytes;
            state.cache_bytes += request.cache_bytes;
        }
        Admission::Granted(Permit {
            inner: Some(Arc::clone(&self.inner)), kind,
            reserved_bytes: request.reserved_bytes, cache_bytes: request.cache_bytes,
        })
    }

    fn validate_request(&self, request: &WorkRequest) -> Result<(), RequestError> {
        let policy = &self.inner.policy;
        if request.reserved_bytes == 0 { return Err(RequestError::ZeroReservation); }
        let limit = if request.kind.is_control() { policy.max_control_operation_bytes } else { policy.max_single_job_reservation_bytes };
        if request.reserved_bytes > limit {
            return Err(RequestError::ReservationTooLarge { requested: request.reserved_bytes, limit });
        }
        if request.file_bytes > policy.max_file_bytes {
            return Err(RequestError::FileTooLarge { requested: request.file_bytes, limit: policy.max_file_bytes });
        }
        if request.cache_bytes > request.reserved_bytes { return Err(RequestError::CacheExceedsReservation); }
        if request.cache_bytes > policy.cache_budget_bytes {
            return Err(RequestError::CacheTooLarge { requested: request.cache_bytes, limit: policy.cache_budget_bytes });
        }
        if request.query_chunks > policy.max_query_chunks {
            return Err(RequestError::TooManyQueryChunks { requested: request.query_chunks, limit: policy.max_query_chunks });
        }
        if request.job_items == 0 { return Err(RequestError::EmptyJob); }
        if request.job_items > policy.max_job_items {
            return Err(RequestError::TooManyJobItems { requested: request.job_items, limit: policy.max_job_items });
        }
        if request.kind.is_control() && (request.file_bytes != 0 || request.cache_bytes != 0 || request.query_chunks != 0 || request.job_items != 1) {
            return Err(RequestError::InvalidControlWorkload);
        }
        Ok(())
    }
}

#[must_use = "keep the permit alive until job buffers and I/O have been released"]
pub struct Permit {
    inner: Option<Arc<Inner>>,
    kind: WorkKind,
    reserved_bytes: u64,
    cache_bytes: u64,
}

impl fmt::Debug for Permit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Permit")
            .field("kind", &self.kind)
            .field("reserved_bytes", &self.reserved_bytes)
            .field("cache_bytes", &self.cache_bytes)
            .finish_non_exhaustive()
    }
}

impl Permit {
    pub fn kind(&self) -> WorkKind { self.kind }
    pub fn reserved_bytes(&self) -> u64 { self.reserved_bytes }

    /// Release only after buffers are freed and any cancelled I/O has stopped.
    /// Releasing a permit does not itself cancel the underlying job or model API.
    pub fn release(self) { drop(self); }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.take() {
            let mut state = inner.lock();
            if self.kind.is_control() {
                state.control -= 1;
                state.control_bytes -= self.reserved_bytes;
            } else {
                if self.kind.is_heavy() { state.heavy -= 1; }
                else if self.kind == WorkKind::ModelRequest { state.model -= 1; }
                else { state.light -= 1; }
                state.work_bytes -= self.reserved_bytes;
                state.cache_bytes -= self.cache_bytes;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PriorityScopeError { TooManyScopes }

impl fmt::Display for PriorityScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooManyScopes => write!(f, "too many local-model-priority scopes"),
        }
    }
}

impl std::error::Error for PriorityScopeError {}

#[must_use = "keep the guard alive for the requested local-model-priority period"]
pub struct LocalModelPriorityGuard { inner: Option<Arc<Inner>> }

impl LocalModelPriorityGuard {
    pub fn leave(self) { drop(self); }
}

impl Drop for LocalModelPriorityGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.take() {
            inner.lock().priority_scopes -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Barrier, atomic::{AtomicUsize, Ordering}};
    use std::thread;

    fn governor() -> ResourceGovernor { ResourceGovernor::new(ResourcePolicy::default()).unwrap() }
    fn take(governor: &ResourceGovernor, request: WorkRequest) -> Permit {
        match governor.try_acquire(request) {
            Admission::Granted(permit) => permit,
            Admission::Deferred(reason) => panic!("unexpected defer: {reason:?}"),
            Admission::Rejected(reason) => panic!("unexpected rejection: {reason:?}"),
        }
    }

    #[test]
    fn model_and_heavy_work_are_exclusive_in_both_directions() {
        let g = governor();
        let model = take(&g, WorkRequest::new(WorkKind::ModelRequest, MIB));
        for kind in [WorkKind::Ocr, WorkKind::IndexRebuild, WorkKind::PdfConversion, WorkKind::ReportRendering] {
            assert!(matches!(g.try_acquire(WorkRequest::new(kind, MIB)), Admission::Deferred(DeferReason::ModelWorkloadActive)));
        }
        assert!(matches!(g.try_acquire(WorkRequest::new(WorkKind::ModelRequest, MIB)), Admission::Deferred(DeferReason::ModelConcurrency)));
        model.release();
        let heavy = take(&g, WorkRequest::new(WorkKind::IndexRebuild, MIB));
        assert!(matches!(g.try_acquire(WorkRequest::new(WorkKind::ModelRequest, MIB)), Admission::Deferred(DeferReason::HeavyWorkloadActive)));
        assert!(matches!(g.try_acquire(WorkRequest::new(WorkKind::Ocr, MIB)), Admission::Deferred(DeferReason::HeavyConcurrency)));
        drop(heavy);
        assert_eq!(g.snapshot().total_reserved_bytes, 0);
    }

    #[test]
    fn explicit_local_model_priority_is_nested_bounded_and_released() {
        let g = governor();
        let first = g.enter_local_model_priority().unwrap();
        let second = g.enter_local_model_priority().unwrap();
        assert!(matches!(g.try_acquire(WorkRequest::new(WorkKind::Ocr, MIB)), Admission::Deferred(DeferReason::LocalModelPriority)));
        let model = take(&g, WorkRequest::new(WorkKind::ModelRequest, MIB));
        first.leave();
        assert_eq!(g.snapshot().local_model_priority_scopes, 1);
        drop(model);
        drop(second);
        let scopes: Vec<_> = (0..MAX_PRIORITY_SCOPES).map(|_| g.enter_local_model_priority().unwrap()).collect();
        assert!(matches!(g.enter_local_model_priority(), Err(PriorityScopeError::TooManyScopes)));
        drop(scopes);
        assert_eq!(g.snapshot().local_model_priority_scopes, 0);
        take(&g, WorkRequest::new(WorkKind::Ocr, MIB)).release();
    }

    #[test]
    fn critical_pressure_allows_only_bounded_control_operations() {
        let g = governor();
        g.set_pressure(MemoryPressure::Critical);
        for kind in [WorkKind::ModelRequest, WorkKind::Ocr, WorkKind::IndexRebuild,
            WorkKind::PdfConversion, WorkKind::ReportRendering, WorkKind::RetrievalQuery, WorkKind::ParseDocument] {
            assert!(matches!(g.try_acquire(WorkRequest::new(kind, 1)), Admission::Deferred(DeferReason::CriticalPressure)));
        }
        let reads: Vec<_> = (0..g.policy().max_control_jobs)
            .map(|_| take(&g, WorkRequest::new(WorkKind::ReadSmallNativeState, 1024))).collect();
        assert!(matches!(g.try_acquire(WorkRequest::new(WorkKind::Cancel, 1024)), Admission::Deferred(DeferReason::ControlConcurrency)));
        assert!(g.snapshot().control_reserved_bytes <= g.policy().control_budget_bytes);
        drop(reads);
        let cancel = take(&g, WorkRequest::new(WorkKind::Cancel, 1024));
        let mut disguised = WorkRequest::new(WorkKind::ReadSmallNativeState, 1024);
        disguised.query_chunks = 1;
        assert!(matches!(g.try_acquire(disguised), Admission::Rejected(RequestError::InvalidControlWorkload)));
        drop(cancel);
        assert_eq!(g.snapshot().total_reserved_bytes, 0);
    }

    #[test]
    fn elevated_pressure_defers_heavy_work_and_counts_existing_reservations() {
        let g = governor();
        let a = take(&g, WorkRequest::new(WorkKind::RetrievalQuery, 16 * MIB));
        let b = take(&g, WorkRequest::new(WorkKind::ParseDocument, 16 * MIB));
        g.set_pressure(MemoryPressure::Elevated);
        assert!(g.snapshot().work_reserved_bytes > g.snapshot().work_budget_bytes);
        assert!(matches!(g.try_acquire(WorkRequest::new(WorkKind::Ocr, 1)), Admission::Deferred(DeferReason::ElevatedPressure)));
        assert!(matches!(g.try_acquire(WorkRequest::new(WorkKind::ModelRequest, 1)), Admission::Deferred(DeferReason::MemoryBudget { available: 0, .. })));
        drop(a);
        take(&g, WorkRequest::new(WorkKind::ModelRequest, MIB)).release();
        drop(b);
        g.set_pressure(MemoryPressure::Normal);
        take(&g, WorkRequest::new(WorkKind::Ocr, MIB)).release();
    }

    #[test]
    fn memory_and_cache_admission_never_borrow_the_control_reserve() {
        let mut policy = ResourcePolicy::default();
        policy.max_single_job_reservation_bytes = policy.native_budget_bytes - policy.control_budget_bytes;
        let g = ResourceGovernor::new(policy).unwrap();
        let all_work = take(&g, WorkRequest::new(WorkKind::RetrievalQuery, g.snapshot().work_budget_bytes));
        assert!(matches!(g.try_acquire(WorkRequest::new(WorkKind::ModelRequest, 1)), Admission::Deferred(DeferReason::MemoryBudget { available: 0, .. })));
        let cancel = take(&g, WorkRequest::new(WorkKind::Cancel, 1024));
        assert!(g.snapshot().total_reserved_bytes <= g.policy().native_budget_bytes);
        drop(all_work);
        drop(cancel);
        let mut cache = WorkRequest::new(WorkKind::RetrievalQuery, 8 * MIB);
        cache.cache_bytes = 8 * MIB;
        let held = take(&g, cache);
        let mut next = WorkRequest::new(WorkKind::ParseDocument, 1);
        next.cache_bytes = 1;
        assert!(matches!(g.try_acquire(next), Admission::Deferred(DeferReason::CacheBudget { available: 0, .. })));
        drop(held);
        assert_eq!(g.snapshot().cache_reserved_bytes, 0);
    }

    #[test]
    fn oversized_single_file_chunks_jobs_and_invalid_policy_are_rejected() {
        let g = governor();
        let mut request = WorkRequest::new(WorkKind::RetrievalQuery, MIB);
        request.file_bytes = g.policy().max_file_bytes + 1;
        assert!(matches!(g.try_acquire(request.clone()), Admission::Rejected(RequestError::FileTooLarge { .. })));
        request.file_bytes = 0;
        request.query_chunks = g.policy().max_query_chunks + 1;
        assert!(matches!(g.try_acquire(request.clone()), Admission::Rejected(RequestError::TooManyQueryChunks { .. })));
        request.query_chunks = 0;
        request.job_items = g.policy().max_job_items + 1;
        assert!(matches!(g.try_acquire(request.clone()), Admission::Rejected(RequestError::TooManyJobItems { .. })));
        request.job_items = 0;
        assert!(matches!(g.try_acquire(request), Admission::Rejected(RequestError::EmptyJob)));
        assert!(matches!(g.try_acquire(WorkRequest::new(WorkKind::ModelRequest, u64::MAX)), Admission::Rejected(RequestError::ReservationTooLarge { .. })));
        for field in ["native", "control", "file", "cache", "chunks", "items", "models", "heavy"] {
            let mut policy = ResourcePolicy::default();
            match field {
                "native" => policy.native_budget_bytes = 0,
                "control" => policy.max_control_operation_bytes = policy.control_budget_bytes,
                "file" => policy.max_file_bytes = 0,
                "cache" => policy.cache_budget_bytes = u64::MAX,
                "chunks" => policy.max_query_chunks = 0,
                "items" => policy.max_job_items = 0,
                "models" => policy.max_model_requests = 0,
                _ => policy.max_heavy_jobs = 0,
            }
            assert!(ResourceGovernor::new(policy).is_err(), "invalid {field} accepted");
        }
        assert_eq!(g.snapshot().total_reserved_bytes, 0);
    }

    #[test]
    fn cancellation_drop_and_unwinding_release_reservations() {
        let g = governor();
        let mut request = WorkRequest::new(WorkKind::IndexRebuild, MIB);
        request.cache_bytes = MIB / 2;
        let interrupted = g.clone();
        assert!(thread::spawn(move || {
            let _job = take(&interrupted, request);
            panic!("synthetic interrupted job");
        }).join().is_err());
        assert_eq!(g.snapshot().active_heavy_jobs, 0);
        assert_eq!(g.snapshot().total_reserved_bytes, 0);
        assert_eq!(g.snapshot().cache_reserved_bytes, 0);
        // A cancellation path frees the actual job's buffers, then its permit.
        let cancelled = take(&g, WorkRequest::new(WorkKind::ModelRequest, MIB));
        cancelled.release();
        take(&g, WorkRequest::new(WorkKind::Ocr, MIB)).release();
        assert_eq!(g.snapshot().active_model_requests, 0);
    }

    #[test]
    fn simultaneous_threads_cannot_exceed_single_model_or_heavy_limit() {
        for kind in [WorkKind::ModelRequest, WorkKind::IndexRebuild] {
            let g = governor();
            let start = Arc::new(Barrier::new(17));
            let admitted = Arc::new(AtomicUsize::new(0));
            let attempted = Arc::new(AtomicUsize::new(0));
            let mut threads = Vec::new();
            for _ in 0..16 {
                let (g, start, admitted, attempted) = (g.clone(), start.clone(), admitted.clone(), attempted.clone());
                threads.push(thread::spawn(move || {
                    start.wait();
                    let permit = match g.try_acquire(WorkRequest::new(kind, MIB)) {
                        Admission::Granted(permit) => { admitted.fetch_add(1, Ordering::SeqCst); Some(permit) },
                        Admission::Deferred(_) => None,
                        Admission::Rejected(reason) => panic!("unexpected rejection {reason:?}"),
                    };
                    attempted.fetch_add(1, Ordering::SeqCst);
                    // The admitted job remains alive until every thread attempted admission.
                    while attempted.load(Ordering::SeqCst) != 16 { thread::yield_now(); }
                    let s = g.snapshot();
                    assert!(s.active_model_requests <= 1 && s.active_heavy_jobs <= 1);
                    assert!(s.total_reserved_bytes <= s.native_budget_bytes);
                    drop(permit);
                }));
            }
            start.wait();
            for worker in threads { worker.join().unwrap(); }
            assert_eq!(admitted.load(Ordering::SeqCst), 1);
            assert_eq!(g.snapshot().total_reserved_bytes, 0);
        }
    }

    #[test]
    fn concurrent_mixed_jobs_cannot_admit_model_and_heavy_together() {
        let g = governor();
        let start = Arc::new(Barrier::new(17));
        let inspected = Arc::new(Barrier::new(16));
        let mut threads = Vec::new();
        for i in 0..16 {
            let (g, start, inspected) = (g.clone(), start.clone(), inspected.clone());
            threads.push(thread::spawn(move || {
                start.wait();
                let kind = if i % 2 == 0 { WorkKind::ModelRequest } else { WorkKind::Ocr };
                let permit = match g.try_acquire(WorkRequest::new(kind, MIB)) {
                    Admission::Granted(permit) => Some(permit),
                    Admission::Deferred(_) => None,
                    Admission::Rejected(reason) => panic!("unexpected rejection {reason:?}"),
                };
                inspected.wait();
                let s = g.snapshot();
                assert!(!(s.active_model_requests > 0 && s.active_heavy_jobs > 0));
                assert!(s.total_reserved_bytes <= s.native_budget_bytes);
                inspected.wait();
                drop(permit);
            }));
        }
        start.wait();
        for worker in threads { worker.join().unwrap(); }
        assert_eq!(g.snapshot().total_reserved_bytes, 0);
    }

    #[test]
    fn concurrent_reservations_stop_at_memory_budget_before_thread_limit() {
        let policy = ResourcePolicy {
            native_budget_bytes: 2 * MIB + 256 * 1024,
            max_single_job_reservation_bytes: MIB,
            cache_budget_bytes: 0,
            max_light_jobs: 16,
            ..ResourcePolicy::default()
        };
        let g = ResourceGovernor::new(policy).unwrap();
        let start = Arc::new(Barrier::new(17));
        let holding = Arc::new(Barrier::new(16));
        let admitted = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..16 {
            let (g, start, holding, admitted) = (g.clone(), start.clone(), holding.clone(), admitted.clone());
            threads.push(thread::spawn(move || {
                start.wait();
                let permit = match g.try_acquire(WorkRequest::new(WorkKind::RetrievalQuery, MIB)) {
                    Admission::Granted(permit) => { admitted.fetch_add(1, Ordering::SeqCst); Some(permit) },
                    Admission::Deferred(DeferReason::MemoryBudget { .. }) => None,
                    _ => panic!("request should fit individually and stop at the memory budget"),
                };
                holding.wait();
                let s = g.snapshot();
                assert_eq!(s.work_reserved_bytes, 2 * MIB);
                assert_eq!(s.active_light_jobs, 2);
                assert!(s.total_reserved_bytes <= s.native_budget_bytes);
                holding.wait();
                drop(permit);
            }));
        }
        start.wait();
        for worker in threads { worker.join().unwrap(); }
        assert_eq!(admitted.load(Ordering::SeqCst), 2);
        assert_eq!(g.snapshot().total_reserved_bytes, 0);
    }

    #[test]
    fn policy_serialization_does_not_add_model_token_or_context_settings() {
        let policy = ResourcePolicy::default();
        let json = serde_json::to_string(&policy).unwrap();
        assert!(!json.contains("token") && !json.contains("context"));
        let restored: ResourcePolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, policy);
        assert!(serde_json::from_str::<ResourcePolicy>(&json.replace("\"maxModelRequests\":1", "\"maxModelRequests\":1,\"maxTokens\":128")).is_err());
    }
}
