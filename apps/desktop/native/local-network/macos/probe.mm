#include <Network/Network.h>
#include <node_api.h>
#include <dispatch/dispatch.h>

enum ProbeOutcome {
  ProbeOutcomePending = 0,
  ProbeOutcomeGranted = 1,
  ProbeOutcomeDenied = 2,
  ProbeOutcomeUnavailable = 3,
};

struct ProbeState {
  dispatch_semaphore_t done;
  nw_connection_t connection;
  ProbeOutcome outcome;
};

struct ProbeRequest {
  napi_async_work work;
  napi_deferred deferred;
  int32_t timeoutMs;
  ProbeOutcome outcome;
};

static bool IsLocalNetworkDenied(nw_connection_t connection) {
  if (@available(macOS 15.0, *)) {
    nw_path_t path = nw_connection_copy_current_path(connection);
    if (path == nil) return false;
    return nw_path_get_status(path) == nw_path_status_unsatisfied &&
      nw_path_get_unsatisfied_reason(path) == nw_path_unsatisfied_reason_local_network_denied;
  }
  return false;
}

static void ExecuteProbe(napi_env env, void* data) {
  auto* request = static_cast<ProbeRequest*>(data);
  request->outcome = ProbeOutcomeUnavailable;
  @autoreleasepool {
    nw_endpoint_t endpoint = nw_endpoint_create_host("169.254.1.1", "9");
    nw_parameters_t parameters = nw_parameters_create_secure_udp(
      NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
    nw_connection_t connection = nw_connection_create(endpoint, parameters);
    if (connection == nil) return;
    dispatch_queue_t queue = dispatch_queue_create("com.kimi.code.local-network-probe", DISPATCH_QUEUE_SERIAL);
    ProbeState state = { dispatch_semaphore_create(0), connection, ProbeOutcomePending };
    nw_connection_set_queue(connection, queue);
    nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t connectionState, nw_error_t error) {
      if (connectionState == nw_connection_state_ready) {
        state.outcome = ProbeOutcomeGranted;
        dispatch_semaphore_signal(state.done);
        return;
      }
      if (connectionState == nw_connection_state_waiting || connectionState == nw_connection_state_failed) {
        if (IsLocalNetworkDenied(connection)) {
          state.outcome = ProbeOutcomeDenied;
          dispatch_semaphore_signal(state.done);
        } else if (connectionState == nw_connection_state_failed) {
          state.outcome = ProbeOutcomeUnavailable;
          dispatch_semaphore_signal(state.done);
        }
      }
    });
    nw_connection_start(connection);
    int64_t timeoutMs = request->timeoutMs > 0 ? request->timeoutMs : 1500;
    if (dispatch_semaphore_wait(state.done, dispatch_time(DISPATCH_TIME_NOW, timeoutMs * NSEC_PER_MSEC)) == 0) {
      request->outcome = state.outcome;
    }
    nw_connection_set_state_changed_handler(connection, nil);
    nw_connection_cancel(connection);
    dispatch_sync(queue, ^{});
  }
}

static void CompleteProbe(napi_env env, napi_status status, void* data) {
  auto* request = static_cast<ProbeRequest*>(data);
  const char* result = status != napi_ok || request->outcome == ProbeOutcomeUnavailable
    ? "unavailable"
    : request->outcome == ProbeOutcomeGranted
      ? "granted"
      : "denied";
  napi_value value;
  napi_create_string_utf8(env, result, NAPI_AUTO_LENGTH, &value);
  napi_resolve_deferred(env, request->deferred, value);
  napi_delete_async_work(env, request->work);
  delete request;
}

static napi_value Probe(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument;
  int32_t timeoutMs = 1500;
  napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr);
  if (count != 1 || napi_get_value_int32(env, argument, &timeoutMs) != napi_ok || timeoutMs <= 0 || timeoutMs > 30000) {
    timeoutMs = 1500;
  }
  auto* request = new ProbeRequest{};
  request->timeoutMs = timeoutMs;
  napi_value promise;
  napi_value name;
  napi_create_promise(env, &request->deferred, &promise);
  napi_create_string_utf8(env, "LocalNetworkProbe", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, ExecuteProbe, CompleteProbe, request, &request->work);
  napi_queue_async_work(env, request->work);
  return promise;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value probe;
  napi_create_function(env, "probe", NAPI_AUTO_LENGTH, Probe, nullptr, &probe);
  napi_set_named_property(env, exports, "probe", probe);
  return exports;
}

NAPI_MODULE(local_network_probe, Init)
