#import "WorkspacePanel.h"

@interface OBPageView : NSView <NSTextInputClient>
- (instancetype)initWithCall:(WorkspaceCall)call;
- (void)displayPage:(NSDictionary *)handle mode:(NSString *)mode generation:(NSString *)generation;
@end
