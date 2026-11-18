#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <cstring>

@interface KimiTestImplicitLevelInputView : NSView <NSTextInputClient>
@end

@implementation KimiTestImplicitLevelInputView
- (void)insertText:(id)string replacementRange:(NSRange)replacementRange {}
- (void)doCommandBySelector:(SEL)selector {}
- (void)setMarkedText:(id)string selectedRange:(NSRange)selectedRange replacementRange:(NSRange)replacementRange {}
- (void)unmarkText {}
- (NSRange)selectedRange { return NSMakeRange(0, 0); }
- (NSRange)markedRange { return NSMakeRange(NSNotFound, 0); }
- (BOOL)hasMarkedText { return NO; }
- (NSAttributedString*)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actualRange { return nil; }
- (NSArray<NSAttributedStringKey>*)validAttributesForMarkedText { return @[]; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actualRange { return NSZeroRect; }
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }
@end

@interface KimiTestExplicitLevelInputView : KimiTestImplicitLevelInputView
@end

@implementation KimiTestExplicitLevelInputView
- (NSInteger)windowLevel { return 77; }
@end

static NSWindow* WindowFromBuffer(napi_env env, napi_value value) {
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &data, &length) != napi_ok || length != sizeof(void*)) return nil;
  void* pointer = nullptr;
  std::memcpy(&pointer, data, sizeof(pointer));
  NSView* view = (__bridge NSView*)pointer;
  return view.window;
}

static NSView* FindSubviewByClassName(NSView* root, NSString* name) {
  if (root == nil) return nil;
  if ([NSStringFromClass([root class]) isEqualToString:name]) return root;
  for (NSView* subview in root.subviews) {
    NSView* match = FindSubviewByClassName(subview, name);
    if (match != nil) return match;
  }
  return nil;
}

static NSInteger QueryWindowLevel(NSView* view) {
  SEL selector = @selector(windowLevel);
  if (view == nil || ![view respondsToSelector:selector]) return -9999;
  return ((NSInteger (*)(id, SEL))objc_msgSend)(view, selector);
}

static void SetInt(napi_env env, napi_value object, const char* key, int64_t value) {
  napi_value item;
  napi_create_int64(env, value, &item);
  napi_set_named_property(env, object, key, item);
}

static void SetBool(napi_env env, napi_value object, const char* key, bool value) {
  napi_value item;
  napi_get_boolean(env, value, &item);
  napi_set_named_property(env, object, key, item);
}

static napi_value RwhvResponds(napi_env env, napi_callback_info) {
  Class target = NSClassFromString(@"RenderWidgetHostViewCocoa");
  bool responds = target != Nil && [target instancesRespondToSelector:@selector(windowLevel)];
  napi_value result;
  napi_get_boolean(env, responds, &result);
  return result;
}

static KimiTestImplicitLevelInputView* gImplicitView = nil;
static KimiTestExplicitLevelInputView* gExplicitView = nil;

static napi_value AttachSyntheticClients(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr);
  NSWindow* window = WindowFromBuffer(env, arg);
  gImplicitView = [[KimiTestImplicitLevelInputView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)];
  gExplicitView = [[KimiTestExplicitLevelInputView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)];
  [window.contentView addSubview:gImplicitView];
  [window.contentView addSubview:gExplicitView];
  napi_value result;
  napi_create_object(env, &result);
  SetBool(env, result, "implicitRespondsBefore", [gImplicitView respondsToSelector:@selector(windowLevel)]);
  SetInt(env, result, "explicitLevelBefore", QueryWindowLevel(gExplicitView));
  return result;
}

static napi_value InspectWindows(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  NSWindow* overlay = WindowFromBuffer(env, args[0]);
  NSWindow* normal = WindowFromBuffer(env, args[1]);
  NSView* overlayRwhv = FindSubviewByClassName(overlay.contentView, @"RenderWidgetHostViewCocoa");
  NSView* normalRwhv = FindSubviewByClassName(normal.contentView, @"RenderWidgetHostViewCocoa");
  KimiTestImplicitLevelInputView* detached = [[KimiTestImplicitLevelInputView alloc] initWithFrame:NSMakeRect(0, 0, 10, 10)];

  napi_value result;
  napi_create_object(env, &result);
  SetBool(env, result, "overlayHasRwhv", overlayRwhv != nil);
  SetBool(env, result, "normalHasRwhv", normalRwhv != nil);
  SetInt(env, result, "overlayWindowLevel", overlay.level);
  SetInt(env, result, "normalWindowLevel", normal.level);
  SetInt(env, result, "overlayRwhvLevel", QueryWindowLevel(overlayRwhv));
  SetInt(env, result, "normalRwhvLevel", QueryWindowLevel(normalRwhv));
  SetInt(env, result, "implicitAttachedLevel", QueryWindowLevel(gImplicitView));
  SetInt(env, result, "implicitDetachedLevel", QueryWindowLevel(detached));
  SetInt(env, result, "explicitAttachedLevel", QueryWindowLevel(gExplicitView));
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "rwhvResponds", NAPI_AUTO_LENGTH, RwhvResponds, nullptr, &fn);
  napi_set_named_property(env, exports, "rwhvResponds", fn);
  napi_create_function(env, "attachSyntheticClients", NAPI_AUTO_LENGTH, AttachSyntheticClients, nullptr, &fn);
  napi_set_named_property(env, exports, "attachSyntheticClients", fn);
  napi_create_function(env, "inspectWindows", NAPI_AUTO_LENGTH, InspectWindows, nullptr, &fn);
  napi_set_named_property(env, exports, "inspectWindows", fn);
  return exports;
}

NAPI_MODULE(screenshot_macos_overlay_probe, Init)
