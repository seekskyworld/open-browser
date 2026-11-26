#import <AppKit/AppKit.h>
#import <signal.h>
#import "OBControlBar.h"

// Chromium owns the window, menus and web input. The bundle launcher owns
// the local service lifetime and forwards Dock reopen events to its window.
@interface Launcher : NSObject <NSApplicationDelegate>
@property(strong) NSTask *service;
@property(strong) OBControlBar *bar;
@property(strong) NSFileHandle *input;
@property(strong) dispatch_queue_t writer;
@property BOOL ready;
@property BOOL quitting;
@end

@implementation Launcher
- (void)applicationDidFinishLaunching:(NSNotification *)note {
    NSURL *resources = NSBundle.mainBundle.resourceURL;
    NSURL *app = [resources URLByAppendingPathComponent:@"app"];
    self.service = [NSTask new];
    self.service.currentDirectoryURL = app;
    self.service.executableURL = [resources URLByAppendingPathComponent:@"node/bin/node"];
    self.service.arguments = @[[app URLByAppendingPathComponent:@"service.mjs"].path, @"--chromium", @"--desktop-bar"];
    NSPipe *output = [NSPipe pipe];
    self.service.standardOutput = output;
    NSPipe *input = [NSPipe pipe];
    self.service.standardInput = input;
    self.input = input.fileHandleForWriting;
    self.writer = dispatch_queue_create("open-browser.desktop.bar.write", DISPATCH_QUEUE_SERIAL);
    signal(SIGPIPE, SIG_IGN);
    __weak Launcher *owner = self;
    self.service.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [owner.bar stop];
            owner.ready = NO;
            if (owner.quitting) { [NSApp replyToApplicationShouldTerminate:YES]; return; }
            if (task.terminationStatus != 0) [owner showError:@"本机浏览器服务已退出。请检查是否已从源码启动同一服务。"];
            [NSApp terminate:nil];
        });
    };
    NSError *error = nil;
    if (![self.service launchAndReturnError:&error]) {
        [self showError:error.localizedDescription]; [NSApp terminate:nil]; return;
    }
    self.bar = [[OBControlBar alloc] initWithEngineRoot:[app URLByAppendingPathComponent:@".open-browser/engine"]
        servicePID:self.service.processIdentifier send:^(NSDictionary *event) { [owner sendEvent:event]; }];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        [owner readEvents:output.fileHandleForReading];
    });
}

- (void)sendEvent:(NSDictionary *)event {
    if (!self.ready || self.quitting || !self.service.running) return;
    NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:event options:0 error:NULL] mutableCopy];
    if (!line) return;
    [line appendBytes:"\n" length:1];
    dispatch_async(self.writer, ^{ [self.input writeData:line error:NULL]; });
}

- (void)readEvents:(NSFileHandle *)handle {
    NSMutableData *line = [NSMutableData data];
    BOOL skip = NO;
    for (;;) @autoreleasepool {
        NSData *chunk = handle.availableData;
        if (!chunk.length) return;
        const uint8_t *start = chunk.bytes, *end = start + chunk.length;
        while (start < end) {
            const uint8_t *newline = memchr(start, '\n', end - start);
            NSUInteger count = (newline ?: end) - start;
            if (!skip && line.length + count <= 65536) [line appendBytes:start length:count];
            else skip = YES;
            if (!newline) break;
            if (!skip) {
                id message = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
                BOOL ready = [line isEqualToData:[@"open-browser ready" dataUsingEncoding:NSUTF8StringEncoding]];
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (!self.service.running || self.quitting) return;
                    NSDictionary *event = [message isKindOfClass:NSDictionary.class] ? message : nil;
                    if (ready || [event[@"ready"] isEqual:@YES]) self.ready = YES;
                    if ([event[@"event"] isEqual:@"desktop.bar"]) [self.bar update:event[@"bar"]];
                });
            }
            [line setLength:0]; skip = NO;
            start = newline + 1;
        }
    }
}
- (void)showError:(NSString *)message {
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"open-browser";
    alert.informativeText = message;
    [NSApp activateIgnoringOtherApps:YES];
    [alert runModal];
}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)app hasVisibleWindows:(BOOL)flag {
    if (self.ready && self.service.running) kill(self.service.processIdentifier, SIGUSR2);
    return YES;
}
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)app {
    if (!self.service.running) return NSTerminateNow;
    self.quitting = YES;
    [self.bar stop];
    [self.service terminate];
    return NSTerminateLater;
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        __attribute__((objc_precise_lifetime)) Launcher *delegate = [Launcher new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
