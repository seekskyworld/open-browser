#import "OBControlBar.h"
#import <CoreGraphics/CoreGraphics.h>
#import <sys/sysctl.h>

@interface OBPanel : NSPanel
@end
@implementation OBPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface OBBarButton : NSButton
@property(copy) NSDictionary *binding;
@property(copy) NSDictionary *pressedBinding;
@end
@implementation OBBarButton
- (BOOL)acceptsFirstResponder { return NO; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)mouseDown:(NSEvent *)event {
    self.pressedBinding = self.binding;
    [super mouseDown:event];
    self.pressedBinding = nil;
}
@end

static BOOL IsChildOfService(pid_t pid, pid_t servicePID) {
    for (int i = 0; i < 8 && pid > 1; i++) {
        if (pid == servicePID) return YES;
        struct kinfo_proc info = {0};
        size_t size = sizeof(info);
        int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
        if (sysctl(mib, 4, &info, &size, NULL, 0) < 0 || size != sizeof(info)) return NO;
        pid = info.kp_eproc.e_ppid;
    }
    return NO;
}

// WindowServer and chrome.windows both express these bounds in desktop points,
// measured from the top left of the primary display.
static BOOL FrontWindowMatches(pid_t pid, CGRect expected) {
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    for (NSDictionary *info in windows) {
        if ([info[(id)kCGWindowOwnerPID] intValue] != pid || [info[(id)kCGWindowLayer] integerValue] != 0) continue;
        CGRect bounds;
        if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)info[(id)kCGWindowBounds], &bounds)) continue;
        return fabs(bounds.origin.x - expected.origin.x) <= 3 && fabs(bounds.origin.y - expected.origin.y) <= 3 &&
               fabs(bounds.size.width - expected.size.width) <= 3 && fabs(bounds.size.height - expected.size.height) <= 3;
    }
    return NO;
}

static NSString *Text(id value) { return [value isKindOfClass:NSString.class] ? value : @""; }

@interface OBControlBar ()
@property(strong) OBPanel *panel;
@property(strong) NSTextField *agent, *status;
@property(strong) OBBarButton *button, *delivery;
@property(strong) NSView *dot;
@property(copy) NSDictionary *bar, *pending;
@property(copy) NSString *rootPrefix;
@property(copy) void (^send)(NSDictionary *);
@property pid_t servicePID;
@property(strong) NSTimer *timer;
@end

@implementation OBControlBar
- (instancetype)initWithEngineRoot:(NSURL *)root servicePID:(pid_t)pid send:(void (^)(NSDictionary *))send {
    if (!(self = [super init])) return nil;
    _servicePID = pid;
    _rootPrefix = [root.URLByResolvingSymlinksInPath.path stringByAppendingString:@"/"];
    _send = [send copy];
    _panel = [[OBPanel alloc] initWithContentRect:NSMakeRect(0, 0, 248, 42)
        styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
    _panel.title = @"open-browser 控制条";
    _panel.floatingPanel = YES;
    _panel.level = NSFloatingWindowLevel;
    _panel.hidesOnDeactivate = NO;
    _panel.opaque = NO;
    _panel.backgroundColor = NSColor.clearColor;
    _panel.hasShadow = YES;
    _panel.releasedWhenClosed = NO;
    _panel.excludedFromWindowsMenu = YES;
    _panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle;

    NSVisualEffectView *surface = [NSVisualEffectView new];
    surface.material = NSVisualEffectMaterialPopover;
    surface.state = NSVisualEffectStateActive;
    surface.wantsLayer = YES;
    surface.layer.cornerRadius = 13;
    surface.layer.masksToBounds = YES;
    _panel.contentView = surface;
    _dot = [NSView new];
    _dot.wantsLayer = YES;
    _dot.layer.cornerRadius = 4;
    [_dot.widthAnchor constraintEqualToConstant:8].active = YES;
    [_dot.heightAnchor constraintEqualToConstant:8].active = YES;
    _agent = [NSTextField labelWithString:@""];
    _agent.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    _agent.lineBreakMode = NSLineBreakByTruncatingTail;
    [_agent setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    _status = [NSTextField labelWithString:@""];
    _status.font = [NSFont systemFontOfSize:12];
    _status.textColor = NSColor.secondaryLabelColor;
    _button = [OBBarButton buttonWithTitle:@"人工接管" target:self action:@selector(click:)];
    _button.bezelStyle = NSBezelStyleRounded;
    _button.controlSize = NSControlSizeSmall;
    _button.focusRingType = NSFocusRingTypeNone;
    _delivery = [OBBarButton buttonWithTitle:@"结束" target:self action:@selector(click:)];
    _delivery.bezelStyle = NSBezelStyleRounded;
    _delivery.controlSize = NSControlSizeSmall;
    _delivery.toolTip = @"结束当前 Agent 任务并保留现有页面";
    NSStackView *row = [NSStackView stackViewWithViews:@[_dot, _agent, _status, _button, _delivery]];
    row.spacing = 8;
    row.alignment = NSLayoutAttributeCenterY;
    row.translatesAutoresizingMaskIntoConstraints = NO;
    [surface addSubview:row];
    [NSLayoutConstraint activateConstraints:@[
        [row.leadingAnchor constraintEqualToAnchor:surface.leadingAnchor constant:13],
        [row.trailingAnchor constraintEqualToAnchor:surface.trailingAnchor constant:-10],
        [row.centerYAnchor constraintEqualToAnchor:surface.centerYAnchor]
    ]];
    NSNotificationCenter *events = NSWorkspace.sharedWorkspace.notificationCenter;
    [events addObserver:self selector:@selector(frontChanged:) name:NSWorkspaceDidActivateApplicationNotification object:nil];
    [events addObserver:self selector:@selector(frontChanged:) name:NSWorkspaceActiveSpaceDidChangeNotification object:nil];
    return self;
}

- (void)frontChanged:(NSNotification *)note { [self place]; }

- (BOOL)frontMatches:(CGRect)bounds {
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (![front.bundleIdentifier isEqual:@"local.open-browser.chromium"] || front.hidden) return NO;
    NSString *path = front.executableURL.URLByResolvingSymlinksInPath.path;
    return [path hasPrefix:self.rootPrefix] && [path hasSuffix:@"/open-browser.app/Contents/MacOS/open-browser"] &&
           IsChildOfService(front.processIdentifier, self.servicePID) && FrontWindowMatches(front.processIdentifier, bounds);
}

- (void)place {
    if (!self.bar) return;
    CGRect bounds = CGRectMake([self.bar[@"left"] doubleValue], [self.bar[@"top"] doubleValue],
                               [self.bar[@"width"] doubleValue], [self.bar[@"height"] doubleValue]);
    CGFloat viewport = MIN([self.bar[@"viewportWidth"] doubleValue], bounds.size.width);
    if (![self frontMatches:bounds] || viewport < 150 || bounds.size.height < 120) { [self.panel orderOut:nil]; return; }
    CGFloat textWidth = ceil(MIN(160, self.agent.intrinsicContentSize.width) + self.status.intrinsicContentSize.width +
                             self.button.intrinsicContentSize.width + self.delivery.intrinsicContentSize.width + 66);
    CGFloat width = MIN(viewport - 12, MAX(175, textWidth));
    NSScreen *primary = NSScreen.screens.firstObject;
    if (!primary) { [self.panel orderOut:nil]; return; }
    NSRect frame = NSMakeRect(round(CGRectGetMaxX(bounds) - viewport/2 - width/2),
                              round(NSMaxY(primary.frame) - CGRectGetMaxY(bounds) + 16), width, 40);
    if (!NSEqualRects(self.panel.frame, frame)) [self.panel setFrame:frame display:YES];
    if (!self.panel.visible) [self.panel orderFrontRegardless];
}

- (void)update:(NSDictionary *)bar {
    if (![bar isKindOfClass:NSDictionary.class] || !Text(bar[@"workspaceId"]).length ||
        !Text(bar[@"pageId"]).length || !Text(bar[@"controlGeneration"]).length ||
        ![@[@"human", @"agent", @"transferring"] containsObject:Text(bar[@"mode"])]) bar = nil;
    for (NSString *key in @[@"windowId", @"left", @"top", @"width", @"height", @"viewportWidth"]) {
        if (![bar[key] isKindOfClass:NSNumber.class] || !isfinite([bar[key] doubleValue])) { bar = nil; break; }
    }
    self.bar = bar;
    if (!bar) {
        self.pending = nil;
        self.button.binding = nil;
        [self.timer invalidate]; self.timer = nil;
        [self.panel orderOut:nil];
        return;
    }
    NSMutableDictionary *binding = [NSMutableDictionary dictionaryWithObject:@"desktop.bar.click" forKey:@"event"];
    for (NSString *key in @[@"workspaceId", @"pageId", @"windowId", @"controlGeneration", @"mode"]) binding[key] = bar[key];
    self.button.binding = binding;
    NSMutableDictionary *delivery = [binding mutableCopy];
    delivery[@"action"] = @"delivery";
    self.delivery.binding = delivery;
    if (![self.pending isEqual:binding]) self.pending = nil;
    BOOL human = [bar[@"mode"] isEqual:@"human"], transferring = [bar[@"mode"] isEqual:@"transferring"];
    NSDictionary *states = @{@"actionability":@"检查目标", @"dispatching":@"正在派发", @"waiting":@"等待页面", @"verifying":@"核对结果", @"dispatched":@"已派发", @"running":@"执行中", @"queued":@"已排队", @"idle":@"待命", @"completed":@"已完成",
        @"needs_credential":@"等待凭据", @"failed":@"失败", @"cancelled":@"已取消", @"outcome_unknown":@"待核实"};
    self.agent.stringValue = Text(bar[@"agentName"]).length ? bar[@"agentName"] : @"Agent";
    self.agent.toolTip = self.agent.stringValue;
    self.status.stringValue = transferring ? @"交接中" : human ? @"人工控制" : states[Text(bar[@"phase"])] ?: @"待命";
    self.button.title = human ? @"交回 Agent" : @"人工接管";
    self.delivery.enabled = !transferring;
    self.button.enabled = !transferring && !self.pending;
    NSColor *color = transferring ? NSColor.systemOrangeColor : human ? NSColor.systemGreenColor : NSColor.systemBlueColor;
    self.dot.layer.backgroundColor = color.CGColor;
    if (!self.timer) {
        __weak typeof(self) owner = self;
        self.timer = [NSTimer scheduledTimerWithTimeInterval:0.35 repeats:YES block:^(NSTimer *timer) { [owner place]; }];
    }
    [self place];
}

- (void)click:(OBBarButton *)button {
    [self place];
    NSDictionary *binding = button.pressedBinding ?: button.binding;
    if (!binding || !button.enabled || !self.panel.visible || ![binding isEqual:button.binding]) return;
    self.pending = binding;
    button.enabled = NO;
    self.send(binding);
    __weak typeof(self) owner = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3*NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (owner.pending == binding) { owner.pending = nil; [owner update:owner.bar]; }
    });
}

- (void)stop {
    [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:self];
    [self update:nil];
}
@end
