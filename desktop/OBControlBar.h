#import <AppKit/AppKit.h>

@interface OBControlBar : NSObject
- (instancetype)initWithEngineRoot:(NSURL *)root servicePID:(pid_t)servicePID send:(void (^)(NSDictionary *event))send;
- (void)update:(NSDictionary *)bar;
- (void)stop;
@end
