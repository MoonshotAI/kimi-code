#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <cstring>

static NSInteger TextInputWindowLevel(__unsafe_unretained id self, SEL) {
  if (![self isKindOfClass:[NSView class]]) return NSNormalWindowLevel;
  NSWindow* window = ((NSView*)self).window;
  return window != nil ? window.level : NSNormalWindowLevel;
}

static void InstallTextInputWindowLevel(Class targetClass) {
  if (targetClass == Nil || ![targetClass isSubclassOfClass:[NSView class]] ||
      ![targetClass conformsToProtocol:@protocol(NSTextInputClient)]) {
    return;
  }
  SEL selector = @selector(windowLevel);
  if ([targetClass instancesRespondToSelector:selector]) return;
  objc_method_description method =
      protocol_getMethodDescription(@protocol(NSTextInputClient), selector, NO, YES);
  const char* types = method.types != nullptr ? method.types : "q@:";
  class_addMethod(targetClass, selector, reinterpret_cast<IMP>(TextInputWindowLevel), types);
}

static void ConfigureTextInputClients(NSView* root) {
  if (root == nil) return;
  InstallTextInputWindowLevel([root class]);
  for (NSView* subview in root.subviews) {
    ConfigureTextInputClients(subview);
  }
}

static NSWindow* WindowFromHandle(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value argument;
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok ||
      count != 1 || napi_get_buffer_info(env, argument, &data, &length) != napi_ok ||
      length != sizeof(void*) || ![NSThread isMainThread]) {
    napi_throw_type_error(env, nullptr, "Invalid screenshot window handle");
    return nullptr;
  }
  void* pointer = nullptr;
  std::memcpy(&pointer, data, sizeof(pointer));
  NSView* view = (__bridge NSView*)pointer;
  NSWindow* window = view.window;
  if (window == nil) {
    napi_throw_error(env, nullptr, "Screenshot window is unavailable");
    return nullptr;
  }
  return window;
}

static napi_value ConfigureOverlay(napi_env env, napi_callback_info info) {
  NSWindow* window = WindowFromHandle(env, info);
  if (window == nil) return nullptr;
  window.animationBehavior = NSWindowAnimationBehaviorNone;
  InstallTextInputWindowLevel(NSClassFromString(@"RenderWidgetHostViewCocoa"));
  ConfigureTextInputClients(window.contentView);
  napi_value result;
  NSString* windowId = [NSString stringWithFormat:@"%ld", (long)window.windowNumber];
  napi_create_string_utf8(env, windowId.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value ConfigurePin(napi_env env, napi_callback_info info) {
  NSWindow* window = WindowFromHandle(env, info);
  if (window == nil) return nullptr;
  SEL selector = NSSelectorFromString(@"_setPreventsActivation:");
  if (![window respondsToSelector:selector]) {
    napi_throw_error(env, nullptr, "nonactivating-pin-unsupported");
    return nullptr;
  }
  ((void (*)(id, SEL, BOOL))objc_msgSend)(window, selector, YES);
  window.animationBehavior = NSWindowAnimationBehaviorNone;
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value configure;
  napi_create_function(env, "configure", NAPI_AUTO_LENGTH, ConfigureOverlay, nullptr, &configure);
  napi_set_named_property(env, exports, "configure", configure);
  napi_value configurePin;
  napi_create_function(env, "configurePin", NAPI_AUTO_LENGTH, ConfigurePin, nullptr, &configurePin);
  napi_set_named_property(env, exports, "configurePin", configurePin);
  return exports;
}

NAPI_MODULE(screenshot_overlay, Init)
