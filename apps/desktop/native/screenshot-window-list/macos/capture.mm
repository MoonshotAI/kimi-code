#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <node_api.h>
#include <cmath>

struct CaptureRequest {
  napi_async_work work;
  napi_deferred deferred;
  int32_t mode;
  NSMutableArray<NSDictionary*>* frames;
  NSString* error;
  bool permissionDenied;
};

static void ExecuteCapture(napi_env env, void* data) {
  auto* request = static_cast<CaptureRequest*>(data);
  @autoreleasepool {
    if (@available(macOS 14.0, *)) {
      __block SCShareableContent* content = nil;
      __block NSError* contentError = nil;
      dispatch_semaphore_t contentReady = dispatch_semaphore_create(0);
      [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
          completionHandler:^(SCShareableContent* result, NSError* error) {
            content = result;
            contentError = error;
            dispatch_semaphore_signal(contentReady);
          }];
      if (dispatch_semaphore_wait(contentReady, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
        request->error = @"native-capture-content-timeout";
        return;
      }
      if (content == nil || contentError != nil) {
        request->permissionDenied = [contentError.domain isEqualToString:SCStreamErrorDomain] && contentError.code == SCStreamErrorUserDeclined;
        request->error = [NSString stringWithFormat:@"native-capture-content:%@:%ld", contentError.domain, (long)contentError.code];
        return;
      }
      request->frames = [NSMutableArray array];
      for (SCDisplay* display in content.displays) {
        SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        if (@available(macOS 14.2, *)) filter.includeMenuBar = YES;
        SCStreamConfiguration* configuration = [[SCStreamConfiguration alloc] init];
        configuration.width = std::lround(filter.contentRect.size.width * filter.pointPixelScale);
        configuration.height = std::lround(filter.contentRect.size.height * filter.pointPixelScale);
        configuration.showsCursor = NO;
        if (request->mode >= 1) configuration.ignoreShadowsDisplay = NO;
        if (request->mode >= 2) configuration.ignoreShadowsSingleWindow = NO;
        __block NSData* png = nil;
        __block size_t width = 0;
        __block size_t height = 0;
        __block NSError* captureError = nil;
        dispatch_semaphore_t frameReady = dispatch_semaphore_create(0);
        [SCScreenshotManager captureImageWithFilter:filter configuration:configuration
            completionHandler:^(CGImageRef image, NSError* error) {
              captureError = error;
              if (image != nil) {
                width = CGImageGetWidth(image);
                height = CGImageGetHeight(image);
                NSBitmapImageRep* bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
                png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
              }
              dispatch_semaphore_signal(frameReady);
            }];
        if (dispatch_semaphore_wait(frameReady, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0) {
          request->error = @"native-capture-frame-timeout";
          return;
        }
        if (png == nil || captureError != nil) {
          request->permissionDenied = [captureError.domain isEqualToString:SCStreamErrorDomain] && captureError.code == SCStreamErrorUserDeclined;
          request->error = [NSString stringWithFormat:@"native-capture-frame:%@:%ld", captureError.domain, (long)captureError.code];
          return;
        }
        [request->frames addObject:@{ @"displayId": [NSString stringWithFormat:@"%u", display.displayID], @"png": png, @"width": @(width), @"height": @(height) }];
      }
      if (request->frames.count == 0) request->error = @"native-capture-no-displays";
    } else {
      request->error = @"native-capture-unsupported";
    }
  }
}

static void CompleteCapture(napi_env env, napi_status status, void* data) {
  auto* request = static_cast<CaptureRequest*>(data);
  if (status != napi_ok || request->error != nil) {
    napi_value message;
    napi_value error;
    napi_create_string_utf8(env, (request->error ?: @"native-capture-cancelled").UTF8String, NAPI_AUTO_LENGTH, &message);
    napi_value code;
    napi_create_string_utf8(env, request->permissionDenied ? "screen-capture-permission-denied" : "screen-capture-failed", NAPI_AUTO_LENGTH, &code);
    napi_create_error(env, code, message, &error);
    napi_reject_deferred(env, request->deferred, error);
  } else {
    napi_value frames;
    napi_create_array_with_length(env, request->frames.count, &frames);
    uint32_t index = 0;
    for (NSDictionary* item in request->frames) {
      napi_value frame;
      napi_value displayId;
      napi_value png;
      napi_value width;
      napi_value height;
      NSString* id = item[@"displayId"];
      NSData* bytes = item[@"png"];
      napi_create_object(env, &frame);
      napi_create_string_utf8(env, id.UTF8String, NAPI_AUTO_LENGTH, &displayId);
      napi_create_buffer_copy(env, bytes.length, bytes.bytes, nullptr, &png);
      napi_create_uint32(env, [item[@"width"] unsignedIntValue], &width);
      napi_create_uint32(env, [item[@"height"] unsignedIntValue], &height);
      napi_set_named_property(env, frame, "displayId", displayId);
      napi_set_named_property(env, frame, "png", png);
      napi_set_named_property(env, frame, "width", width);
      napi_set_named_property(env, frame, "height", height);
      napi_set_element(env, frames, index++, frame);
    }
    napi_resolve_deferred(env, request->deferred, frames);
  }
  napi_delete_async_work(env, request->work);
  delete request;
}

static napi_value Capture(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument;
  int32_t mode = 0;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_int32(env, argument, &mode) != napi_ok || mode < 0 || mode > 2) {
    napi_throw_type_error(env, nullptr, "Invalid screenshot capture mode");
    return nullptr;
  }
  auto* request = new CaptureRequest{};
  request->mode = mode;
  napi_value promise;
  napi_value name;
  napi_create_promise(env, &request->deferred, &promise);
  napi_create_string_utf8(env, "ScreenshotCapture", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, ExecuteCapture, CompleteCapture, request, &request->work);
  napi_queue_async_work(env, request->work);
  return promise;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value capture;
  napi_create_function(env, "capture", NAPI_AUTO_LENGTH, Capture, nullptr, &capture);
  napi_set_named_property(env, exports, "capture", capture);
  return exports;
}

NAPI_MODULE(screenshot_capture, Init)
