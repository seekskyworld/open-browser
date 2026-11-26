#import "OBPageView.h"

@interface OBPageView ()
@property (copy) WorkspaceCall call;
@property (copy) NSDictionary *handle;
@property (copy) NSString *mode;
@property (copy) NSString *generation;
@property (copy) NSString *documentID;
@property (strong) NSImage *image;
@property NSSize viewport;
@property NSUInteger epoch;
@property BOOL framePending;
@property BOOL inputPending;
@property (strong) NSTimer *timer;
@property (strong) NSTrackingArea *tracking;
@property (strong) NSMutableArray<NSDictionary *> *events;
@property (copy) NSString *marked;
@property NSRange markedSelection;
@property NSPoint caretPoint;
@end

@implementation OBPageView
- (instancetype)initWithCall:(WorkspaceCall)call {
    if ((self = [super initWithFrame:NSZeroRect])) {
        _call = [call copy];
        _events = [NSMutableArray array];
        [self setAccessibilityElement:YES];
        [self setAccessibilityRole:NSAccessibilityImageRole];
        [self setAccessibilityLabel:@"工作区网页"];
        [self setAccessibilityIdentifier:@"open-browser-workspace-page"];
    }
    return self;
}

- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return [self.mode isEqual:@"human"]; }
- (BOOL)canShowPage {
    return self.handle && self.window.isVisible && !self.window.isMiniaturized &&
        (self.window.occlusionState & NSWindowOcclusionStateVisible) &&
        !self.isHiddenOrHasHiddenAncestor && !NSIsEmptyRect(self.visibleRect);
}
- (BOOL)canInput {
    return [self canShowPage] && self.documentID.length && self.generation.length &&
        [self.mode isEqual:@"human"];
}

- (void)clearComposition {
    self.marked = nil;
    [self.inputContext discardMarkedText];
    self.needsDisplay = YES;
}
- (void)discardFrame {
    self.documentID = nil;
    self.image = nil;
    [self.events removeAllObjects];
    [self clearComposition];
}

- (void)displayPage:(NSDictionary *)handle mode:(NSString *)mode generation:(NSString *)generation {
    if ((self.handle == handle || [self.handle isEqual:handle]) &&
        (self.mode == mode || [self.mode isEqual:mode]) &&
        (self.generation == generation || [self.generation isEqual:generation])) return;
    self.epoch++;
    self.handle = handle;
    self.mode = mode;
    self.generation = generation;
    [self discardFrame];
    [self scheduleFrame:0];
}

- (void)viewWillMoveToWindow:(NSWindow *)window {
    NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
    if (self.window) [center removeObserver:self name:NSWindowDidChangeOcclusionStateNotification object:self.window];
    if (window) [center addObserver:self selector:@selector(visibilityChanged:) name:NSWindowDidChangeOcclusionStateNotification object:window];
    [super viewWillMoveToWindow:window];
}
- (void)viewDidMoveToWindow { [super viewDidMoveToWindow]; [self refreshVisibility]; }
- (void)viewDidHide { [super viewDidHide]; [self refreshVisibility]; }
- (void)viewDidUnhide { [super viewDidUnhide]; [self refreshVisibility]; }
- (void)visibilityChanged:(NSNotification *)note { [self refreshVisibility]; }
- (void)setFrameSize:(NSSize)size { [super setFrameSize:size]; [self scheduleFrame:0.04]; }
- (void)refreshVisibility {
    if (![self canShowPage]) {
        self.epoch++;
        [self discardFrame];
    }
    [self scheduleFrame:0];
}

- (void)scheduleFrame:(NSTimeInterval)delay {
    [self.timer invalidate];
    self.timer = nil;
    if (self.framePending || ![self canShowPage]) return;
    __weak OBPageView *weakSelf = self;
    self.timer = [NSTimer timerWithTimeInterval:delay repeats:NO block:^(NSTimer *__unused timer) {
        [weakSelf fetchFrame];
    }];
    [NSRunLoop.mainRunLoop addTimer:self.timer forMode:NSRunLoopCommonModes];
}
- (void)fetchFrame {
    if (self.framePending || ![self canShowPage]) return;
    NSMutableDictionary *request = self.handle.mutableCopy;
    request[@"width"] = @(MAX(320, MIN(1920, lround(self.bounds.size.width))));
    request[@"height"] = @(MAX(200, MIN(1200, lround(self.bounds.size.height))));
    if (self.image && (self.viewport.width != [request[@"width"] doubleValue] ||
                       self.viewport.height != [request[@"height"] doubleValue])) [self discardFrame];
    NSUInteger epoch = self.epoch;
    self.framePending = YES;
    self.call(@"pageFrame", request, ^(id frame, NSString *error) {
        self.framePending = NO;
        if (epoch != self.epoch || ![self canShowPage]) { [self scheduleFrame:0]; return; }
        BOOL valid = !error && [frame isKindOfClass:NSDictionary.class] &&
            [frame[@"documentId"] isKindOfClass:NSString.class] &&
            [frame[@"controlGeneration"] isEqual:self.generation] &&
            [frame[@"data"] isKindOfClass:NSString.class] &&
            [frame[@"width"] doubleValue] > 0 && [frame[@"height"] doubleValue] > 0;
        NSImage *image = nil;
        if (valid) {
            NSData *data = [[NSData alloc] initWithBase64EncodedString:frame[@"data"] options:0];
            if (data) image = [[NSImage alloc] initWithData:data];
        }
        if (!image || ![self.documentID isEqual:frame[@"documentId"]]) [self discardFrame];
        if (image) {
            self.image = image;
            self.documentID = frame[@"documentId"];
            self.viewport = NSMakeSize([frame[@"width"] doubleValue], [frame[@"height"] doubleValue]);
            self.needsDisplay = YES;
        }
        [self scheduleFrame:image ? ([self.mode isEqual:@"human"] ? 0.08 : 0.28) : 0.5];
    });
}

- (NSRect)imageRect {
    if (!self.image || self.viewport.width <= 0 || self.viewport.height <= 0) return NSZeroRect;
    NSRect bounds = self.bounds;
    CGFloat scale = MIN(bounds.size.width / self.viewport.width, bounds.size.height / self.viewport.height);
    NSSize size = NSMakeSize(self.viewport.width * scale, self.viewport.height * scale);
    return NSMakeRect(NSMidX(bounds) - size.width/2, NSMidY(bounds) - size.height/2, size.width, size.height);
}

- (void)drawRect:(NSRect)dirty {
    [NSColor.textBackgroundColor setFill];
    NSRectFill(dirty);
    [self.image drawInRect:[self imageRect] fromRect:NSZeroRect operation:NSCompositingOperationSourceOver
                 fraction:1 respectFlipped:YES hints:nil];
    if (self.marked.length) {
        [self.marked drawAtPoint:self.caretPoint withAttributes:@{
            NSBackgroundColorAttributeName:NSColor.textBackgroundColor,
            NSForegroundColorAttributeName:NSColor.textColor,
            NSUnderlineStyleAttributeName:@(NSUnderlineStyleSingle),
            NSFontAttributeName:[NSFont systemFontOfSize:14]}];
    }
}

- (void)sendNextInput {
    if (self.inputPending || !self.events.count || ![self canInput]) return;
    NSDictionary *event = self.events.firstObject;
    [self.events removeObjectAtIndex:0];
    NSMutableDictionary *params = self.handle.mutableCopy;
    params[@"documentId"] = self.documentID;
    params[@"controlGeneration"] = self.generation;
    params[@"event"] = event;
    NSUInteger epoch = self.epoch;
    self.inputPending = YES;
    self.call(@"pageInput", params, ^(id __unused result, NSString *error) {
        self.inputPending = NO;
        if (error && epoch == self.epoch && [self.documentID isEqual:params[@"documentId"]]) {
            self.epoch++;
            [self discardFrame];
            [self scheduleFrame:0];
        }
        [self sendNextInput];
    });
}
- (void)enqueue:(NSDictionary *)event {
    if (![self canInput]) return;
    NSString *type = event[@"type"];
    NSDictionary *last = self.events.lastObject;
    if ([last[@"type"] isEqual:type] && [type isEqual:@"mouseMove"]) {
        [self.events removeLastObject];
    } else if ([last[@"type"] isEqual:type] && [type isEqual:@"wheel"] &&
               [last[@"x"] isEqual:event[@"x"]] && [last[@"y"] isEqual:event[@"y"]]) {
        NSMutableDictionary *combined = event.mutableCopy;
        for (NSString *axis in @[@"deltaX", @"deltaY"]) {
            CGFloat delta = [last[axis] doubleValue] + [event[axis] doubleValue];
            combined[axis] = @(MAX(-10000, MIN(10000, delta)));
        }
        event = combined;
        [self.events removeLastObject];
    }
    [self.events addObject:event];
    [self sendNextInput];
}

- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    if (self.tracking) [self removeTrackingArea:self.tracking];
    self.tracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect options:
        NSTrackingMouseMoved|NSTrackingActiveInKeyWindow|NSTrackingInVisibleRect owner:self userInfo:nil];
    [self addTrackingArea:self.tracking];
}
- (void)pointer:(NSEvent *)event type:(NSString *)type button:(NSString *)button {
    if (![self canInput]) return;
    NSPoint location = [self convertPoint:event.locationInWindow fromView:nil];
    NSRect rect = [self imageRect];
    if (NSIsEmptyRect(rect)) return;
    if (!NSPointInRect(location, rect) && ![type isEqual:@"mouseUp"] &&
        event.type != NSEventTypeLeftMouseDragged && event.type != NSEventTypeRightMouseDragged &&
        event.type != NSEventTypeOtherMouseDragged) return;
    CGFloat x = (location.x - NSMinX(rect)) * self.viewport.width / NSWidth(rect);
    CGFloat y = (location.y - NSMinY(rect)) * self.viewport.height / NSHeight(rect);
    NSMutableDictionary *payload = [@{@"type":type, @"x":@(MAX(0, MIN(self.viewport.width-1, x))),
        @"y":@(MAX(0, MIN(self.viewport.height-1, y)))} mutableCopy];
    if (button) {
        payload[@"button"] = button;
        payload[@"clickCount"] = @(MAX(1, MIN(3, event.clickCount)));
    }
    if ([type isEqual:@"mouseDown"]) {
        [self.window makeFirstResponder:self];
        self.caretPoint = location;
    } else if ([type isEqual:@"wheel"]) {
        CGFloat scale = event.hasPreciseScrollingDeltas ? 1 : 12;
        payload[@"deltaX"] = @(-event.scrollingDeltaX * scale);
        payload[@"deltaY"] = @(-event.scrollingDeltaY * scale);
    }
    [self enqueue:payload];
}
- (void)mouseMoved:(NSEvent *)e { [self pointer:e type:@"mouseMove" button:nil]; }
- (void)mouseDragged:(NSEvent *)e { [self mouseMoved:e]; }
- (void)rightMouseDragged:(NSEvent *)e { [self mouseMoved:e]; }
- (void)otherMouseDragged:(NSEvent *)e { [self mouseMoved:e]; }
- (void)mouseDown:(NSEvent *)e { [self pointer:e type:@"mouseDown" button:@"left"]; }
- (void)mouseUp:(NSEvent *)e { [self pointer:e type:@"mouseUp" button:@"left"]; }
- (void)rightMouseDown:(NSEvent *)e { [self pointer:e type:@"mouseDown" button:@"right"]; }
- (void)rightMouseUp:(NSEvent *)e { [self pointer:e type:@"mouseUp" button:@"right"]; }
- (void)otherMouseDown:(NSEvent *)e { if (e.buttonNumber == 2) [self pointer:e type:@"mouseDown" button:@"middle"]; }
- (void)otherMouseUp:(NSEvent *)e { if (e.buttonNumber == 2) [self pointer:e type:@"mouseUp" button:@"middle"]; }
- (void)scrollWheel:(NSEvent *)e { [self pointer:e type:@"wheel" button:nil]; }

- (NSString *)specialKey:(NSEvent *)e {
    switch (e.keyCode) {
        case 36: case 76: return @"Enter";
        case 48: return @"Tab";
        case 51: return @"Backspace";
        case 53: return @"Escape";
        case 115: return @"Home";
        case 116: return @"PageUp";
        case 117: return @"Delete";
        case 119: return @"End";
        case 121: return @"PageDown";
        case 123: return @"ArrowLeft";
        case 124: return @"ArrowRight";
        case 125: return @"ArrowDown";
        case 126: return @"ArrowUp";
        default: return nil;
    }
}
- (void)keyEvent:(NSString *)type key:(NSString *)key {
    [self enqueue:@{@"type":type, @"key":key}];
}
- (void)stroke:(NSString *)key flags:(NSEventModifierFlags)flags {
    NSMutableArray<NSString *> *modifiers = [NSMutableArray array];
    if (flags & NSEventModifierFlagCommand) [modifiers addObject:@"Meta"];
    if (flags & NSEventModifierFlagControl) [modifiers addObject:@"Control"];
    if (flags & NSEventModifierFlagOption) [modifiers addObject:@"Alt"];
    if (flags & NSEventModifierFlagShift) [modifiers addObject:@"Shift"];
    for (NSString *modifier in modifiers) [self keyEvent:@"keyDown" key:modifier];
    [self keyEvent:@"keyDown" key:key];
    [self keyEvent:@"keyUp" key:key];
    for (NSString *modifier in modifiers.reverseObjectEnumerator) [self keyEvent:@"keyUp" key:modifier];
}
- (BOOL)performKeyEquivalent:(NSEvent *)e {
    if (self.window.firstResponder == self && [self canInput] && (e.modifierFlags & NSEventModifierFlagCommand)) {
        NSString *key = e.charactersIgnoringModifiers.lowercaseString;
        if ([key isEqual:@"v"]) { [self paste:nil]; return YES; }
        if ([key isEqual:@"a"] || [key isEqual:@"z"]) { [self stroke:key flags:e.modifierFlags]; return YES; }
    }
    return [super performKeyEquivalent:e];
}
- (void)paste:(id)sender {
    if (![self canInput]) return;
    NSString *s = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
    if (s.length) [self insertText:s replacementRange:NSMakeRange(NSNotFound, 0)];
}
- (void)keyDown:(NSEvent *)e {
    if (![self canInput]) return;
    if (self.hasMarkedText) { [self interpretKeyEvents:@[e]]; return; }
    NSString *key = [self specialKey:e];
    if (key || (e.modifierFlags & (NSEventModifierFlagControl|NSEventModifierFlagCommand))) {
        key = key ?: e.charactersIgnoringModifiers.lowercaseString;
        if (key.length) [self stroke:key flags:e.modifierFlags];
    } else if (![self.inputContext handleEvent:e] && e.characters.length) {
        [self insertText:e.characters replacementRange:NSMakeRange(NSNotFound, 0)];
    }
}
- (void)insertText:(id)value {
    [self insertText:value replacementRange:NSMakeRange(NSNotFound, 0)];
}
- (void)keyUp:(NSEvent *)event { /* Keystrokes are released with their modifiers in stroke:flags:. */ }
- (BOOL)resignFirstResponder {
    [self clearComposition];
    return [super resignFirstResponder];
}
- (void)insertText:(id)value replacementRange:(NSRange)replacementRange {
    self.marked = nil;
    NSString *text = [value isKindOfClass:NSAttributedString.class] ? [value string] : value;
    // The private service accepts up to 8192 UTF-16 units per input. Preserve
    // surrogate pairs when a paste crosses that boundary.
    NSUInteger offset = 0;
    while (offset < text.length) {
        NSUInteger length = MIN(8192, text.length - offset);
        if (offset + length < text.length && CFStringIsSurrogateHighCharacter([text characterAtIndex:offset + length - 1])) length--;
        NSString *part = [text substringWithRange:NSMakeRange(offset, length)];
        [self enqueue:@{@"type":@"text", @"text":part}];
        offset += length;
    }
    self.needsDisplay = YES;
}
- (void)doCommandBySelector:(SEL)selector {
    if (selector == @selector(noop:)) return;
    NSString *key = @{@"insertNewline:":@"Enter", @"insertTab:":@"Tab", @"deleteBackward:":@"Backspace",
        @"cancelOperation:":@"Escape", @"moveLeft:":@"ArrowLeft", @"moveRight:":@"ArrowRight",
        @"moveUp:":@"ArrowUp", @"moveDown:":@"ArrowDown"}[NSStringFromSelector(selector)];
    if (key) [self stroke:key flags:0];
}
- (void)setMarkedText:(id)value selectedRange:(NSRange)selection replacementRange:(NSRange)replacement {
    if (![self canInput]) return;
    self.marked = [value isKindOfClass:NSAttributedString.class] ? [value string] : value;
    self.markedSelection = NSIntersectionRange(selection, NSMakeRange(0, self.marked.length));
    self.needsDisplay = YES;
}
- (void)unmarkText { self.marked = nil; self.needsDisplay = YES; }
- (BOOL)hasMarkedText { return self.marked.length != 0; }
- (NSRange)markedRange { return self.hasMarkedText ? NSMakeRange(0, self.marked.length) : NSMakeRange(NSNotFound, 0); }
- (NSRange)selectedRange { return self.hasMarkedText ? self.markedSelection : NSMakeRange(0, 0); }
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
    NSRange match = NSIntersectionRange(range, NSMakeRange(0, self.marked.length));
    if (actual) *actual = match;
    return match.length ? [[NSAttributedString alloc] initWithString:[self.marked substringWithRange:match]] : nil;
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return NSNotFound; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
    if (actual) *actual = self.selectedRange;
    NSRect local = NSMakeRect(self.caretPoint.x, self.caretPoint.y, 1, 18);
    return [self.window convertRectToScreen:[self convertRect:local toView:nil]];
}
@end
