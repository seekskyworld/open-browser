#import <AppKit/AppKit.h>

typedef void (^WorkspaceReply)(id result, NSString *error);
typedef void (^WorkspaceCall)(NSString *method, NSDictionary *params, WorkspaceReply reply);

@interface WorkspacePanel : NSObject
- (instancetype)initWithCall:(WorkspaceCall)call;
- (void)show;
- (void)focusAddress:(id)sender;
- (void)newTab:(id)sender;
- (void)home:(id)sender;
- (void)toggleSplit:(id)sender;
- (void)goBack:(id)sender;
- (void)goForward:(id)sender;
- (void)reloadPage:(id)sender;
@end
