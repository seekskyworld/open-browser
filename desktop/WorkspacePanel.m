#import "WorkspacePanel.h"
#import "OBPageView.h"

static NSDictionary *Map(id value) {
    return [value isKindOfClass:NSDictionary.class] ? value : nil;
}

static NSString *String(id value) {
    return [value isKindOfClass:NSString.class] ? value : @"";
}

static NSTextField *Label(NSString *text, CGFloat size, NSFontWeight weight, NSColor *color) {
    NSTextField *field = [NSTextField labelWithString:text];
    field.font = [NSFont systemFontOfSize:size weight:weight];
    field.textColor = color;
    field.lineBreakMode = NSLineBreakByTruncatingTail;
    [field setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow forOrientation:NSLayoutConstraintOrientationHorizontal];
    return field;
}

static NSStackView *Stack(NSArray<NSView *> *items, BOOL vertical, CGFloat gap) {
    NSStackView *stack = [NSStackView stackViewWithViews:items];
    stack.orientation = vertical ? NSUserInterfaceLayoutOrientationVertical : NSUserInterfaceLayoutOrientationHorizontal;
    stack.alignment = vertical ? NSLayoutAttributeLeading : NSLayoutAttributeCenterY;
    stack.spacing = gap;
    stack.translatesAutoresizingMaskIntoConstraints = NO;
    return stack;
}

static NSString *Operation(NSDictionary *op) {
    if (!op) return @"";
    NSDictionary *kinds = @{@"openPage":@"打开页面", @"observe":@"观察页面", @"act":@"页面操作",
                            @"click":@"点击", @"fill":@"填写", @"fillCredential":@"填写凭据"};
    NSString *kind = kinds[String(op[@"kind"])] ?: @"操作";
    NSString *step = kinds[String(op[@"stepKind"])];
    NSDictionary *phases = @{@"actionability": @"检查目标", @"dispatching": @"正在派发",
                             @"waiting": @"等待页面", @"verifying": @"核对结果", @"running": @"执行中"};
    if (step && [op[@"state"] isEqual:@"running"]) {
        NSString *stage = phases[String(op[@"phase"])] ?: phases[@"running"];
        return [NSString stringWithFormat:@"%@ · %@ · %@/%@ 步", step, stage,
                op[@"completedSteps"] ?: @0, op[@"totalSteps"] ?: @0];
    }
    NSDictionary *states = @{@"queued":@"排队中", @"running":@"执行中", @"completed":@"已完成",
                             @"failed":@"失败", @"outcome_unknown":@"结果待核对", @"cancelled":@"已取消"};
    NSString *state = [op[@"error"] isEqual:@"credential_required"] ? @"缺少凭据" : states[String(op[@"state"])];
    return state ? [NSString stringWithFormat:@"%@ · %@", kind, state] : kind;
}

static NSInteger Group(NSDictionary *workspace) {
    NSDictionary *activity = workspace[@"activity"];
    if (![workspace[@"mode"] isEqual:@"agent"]) return 2;
    if ([activity[@"needsCredential"] boolValue] || [@[@"failed", @"outcome_unknown", @"needs_credential"] containsObject:String(activity[@"phase"])]) return 0;
    if (Map(activity[@"current"]) || [activity[@"queued"] integerValue] || [@[@"queued", @"running"] containsObject:String(activity[@"phase"])]) return 1;
    return 3;
}

static NSString *Status(NSDictionary *workspace) {
    if ([workspace[@"mode"] isEqual:@"human"]) return @"用户控制 · Agent 已暂停";
    if ([workspace[@"mode"] isEqual:@"transferring"]) return @"正在交接控制权";
    NSDictionary *activity = workspace[@"activity"];
    if ([activity[@"needsHumanVerification"] boolValue]) return @"需要人工验证";
    if ([activity[@"needsCredential"] boolValue]) return @"等待补充凭据";
    NSString *current = Operation(Map(activity[@"current"]));
    if (current.length) return current;
    NSDictionary *phase = @{@"running":@"执行中", @"actionability":@"检查目标", @"dispatching":@"正在派发",
                            @"waiting":@"等待页面", @"verifying":@"核对结果", @"queued":@"排队中", @"completed":@"已完成", @"failed":@"执行失败",
                            @"outcome_unknown":@"结果待核对", @"cancelled":@"已取消", @"needs_credential":@"等待补充凭据", @"needs_human_verification":@"需要人工验证"};
    return phase[String(activity[@"phase"])] ?: @"等待指令";
}

static NSDictionary *Find(NSArray *items, NSString *key, NSString *value) {
    for (NSDictionary *item in items) if ([item[key] isEqual:value]) return item;
    return nil;
}

@interface WorkspacePanel () <NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate, NSTextFieldDelegate>
@property(copy) WorkspaceCall call;
@property(strong) NSWindow *window;
@property(strong) OBPageView *pageView;
@property(strong) OBPageView *secondaryPageView;
@property(strong) NSSplitView *pageSplit;
@property(copy) NSDictionary *splitPage;
@property(copy) NSArray *displayedPage;
@property(strong) NSMutableSet<NSString *> *collapsed;
@property(copy) NSString *addressIdentity, *currentURL;
@property(strong) NSMutableDictionary<NSString *,NSMutableArray *> *drafts;
@property BOOL addressEdited, canGoBack, canGoForward;
@property(copy) NSDictionary *locationPending;
@property(strong) NSTextField *address;
@property(strong) NSButton *back, *forward, *reload, *home, *splitButton, *tabButton;
@property(strong) NSPopUpButton *more;
@property(strong) NSMenuItem *preview, *credential, *feedback, *close, *closePageButton;
@property(strong) NSTableView *table;
@property(strong) NSTextField *status, *notice;
@property(strong) NSTextField *emptyTitle;
@property(strong) NSButton *emptyAction;
@property(strong) NSButton *create, *control;
@property(strong) NSStackView *emptyView;
@property(strong) NSArray *workspaces, *rows;
@property(copy) NSString *workspaceID, *pageID;
@property(strong) NSTimer *timer;
@property BOOL refreshing, syncingSelection, busy, connected;
@property NSUInteger revision;
@property(strong) NSAlert *previewSheet;
@property(strong) NSAlert *credentialSheet;
@property(strong) NSSecureTextField *secretField;
@property(copy) NSDictionary *pendingSelection;
@end

@implementation WorkspacePanel

- (instancetype)initWithCall:(WorkspaceCall)call {
    if ((self = [super init])) {
        _call = [call copy];
        _workspaces = @[];
        _rows = @[];
        _collapsed = [NSMutableSet set];
        _drafts = [NSMutableDictionary dictionary];
        [self buildPanel];
    }
    return self;
}

- (NSButton *)button:(NSString *)title action:(SEL)action {
    NSButton *button = [NSButton buttonWithTitle:title target:self action:action];
    button.controlSize = NSControlSizeSmall;
    button.font = [NSFont systemFontOfSize:NSFont.smallSystemFontSize];
    return button;
}

- (NSButton *)icon:(NSString *)symbol label:(NSString *)label action:(SEL)action {
    NSButton *button = [self button:@"" action:action];
    button.image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:label];
    button.imagePosition = NSImageOnly;
    button.bordered = NO;
    button.toolTip = label;
    [button setAccessibilityLabel:label];
    [button.widthAnchor constraintEqualToConstant:25].active = YES;
    [button.heightAnchor constraintEqualToConstant:25].active = YES;
    return button;
}

- (NSMenuItem *)menuItem:(NSString *)title action:(SEL)action {
    NSMenuItem *item = [self.more.menu addItemWithTitle:title action:action keyEquivalent:@""];
    item.target = self;
    return item;
}

- (void)buildPanel {
    NSRect screen = (NSScreen.mainScreen ?: NSScreen.screens.firstObject).visibleFrame;
    NSSize size = NSMakeSize(MIN(1180, MAX(760, screen.size.width - 72)), MIN(790, MAX(470, screen.size.height - 85)));
    self.window = [[NSWindow alloc] initWithContentRect:(NSRect){NSZeroPoint, size}
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"open-browser";
    self.window.releasedWhenClosed = NO;
    self.window.delegate = self;
    self.window.contentMinSize = NSMakeSize(760, 470);

    self.status = Label(@"", 11, NSFontWeightRegular, NSColor.secondaryLabelColor);
    self.notice = [NSTextField wrappingLabelWithString:@""];
    self.notice.font = [NSFont systemFontOfSize:12];
    self.notice.maximumNumberOfLines = 2;
    self.notice.hidden = YES;
    self.create = [self icon:@"plus" label:@"新建工作区" action:@selector(createWorkspace:)];
    self.back = [self icon:@"chevron.left" label:@"后退" action:@selector(goBack:)];
    self.forward = [self icon:@"chevron.right" label:@"前进" action:@selector(goForward:)];
    self.reload = [self icon:@"arrow.clockwise" label:@"刷新" action:@selector(reloadPage:)];
    self.home = [self icon:@"house" label:@"主页" action:@selector(home:)];
    self.splitButton = [self icon:@"rectangle.split.2x1" label:@"拆分页面" action:@selector(toggleSplit:)];
    self.tabButton = [self icon:@"plus" label:@"新建标签页" action:@selector(newTab:)];
    self.control = [self button:@"接管" action:@selector(changeControl:)];
    self.more = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:YES];
    self.more.bordered = NO;
    self.more.controlSize = NSControlSizeSmall;
    self.more.toolTip = @"更多操作";
    [self.more setAccessibilityLabel:@"更多操作"];
    self.more.menu.autoenablesItems = NO;
    [self.more addItemWithTitle:@""];
    self.more.itemArray.firstObject.image = [NSImage imageWithSystemSymbolName:@"ellipsis.circle" accessibilityDescription:@"更多操作"];
    self.more.imagePosition = NSImageOnly;
    self.credential = [self menuItem:@"绑定凭据…" action:@selector(credentials:)];
    self.preview = [self menuItem:@"查看页面文本…" action:@selector(previewPage:)];
    self.feedback = [self menuItem:@"反馈问题…" action:@selector(feedback:)];
    [self.more.menu addItem:NSMenuItem.separatorItem];
    self.closePageButton = [self menuItem:@"关闭标签页" action:@selector(closePage:)];
    self.close = [self menuItem:@"关闭工作区…" action:@selector(closeWorkspace:)];
    self.address = [[NSTextField alloc] initWithFrame:NSZeroRect];
    self.address.placeholderString = @"输入网址";
    self.address.bezelStyle = NSTextFieldRoundedBezel;
    self.address.font = [NSFont systemFontOfSize:13];
    self.address.usesSingleLineMode = YES;
    self.address.delegate = self;
    self.address.target = self;
    self.address.action = @selector(submitAddress:);
    [(NSTextFieldCell *)self.address.cell setSendsActionOnEndEditing:NO];
    [self.address setAccessibilityLabel:@"地址栏"];
    self.window.initialFirstResponder = self.address;
    self.table = [[NSTableView alloc] initWithFrame:NSZeroRect];
    NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"workspace"];
    column.resizingMask = NSTableColumnAutoresizingMask;
    [self.table addTableColumn:column];
    self.table.headerView = nil;
    self.table.delegate = self;
    self.table.dataSource = self;
    self.table.usesAutomaticRowHeights = NO;
    self.table.floatsGroupRows = NO;
    self.table.columnAutoresizingStyle = NSTableViewLastColumnOnlyAutoresizingStyle;
    self.table.style = NSTableViewStyleSourceList;
    self.table.backgroundColor = NSColor.clearColor;
    [self.table setAccessibilityLabel:@"工作区与页面"];
    NSScrollView *scroll = [[NSScrollView alloc] init];
    scroll.documentView = self.table;
    scroll.hasVerticalScroller = YES;
    scroll.autohidesScrollers = YES;
    scroll.drawsBackground = NO;

    NSVisualEffectView *sidebar = [[NSVisualEffectView alloc] initWithFrame:NSMakeRect(0, 0, 190, size.height)];
    sidebar.material = NSVisualEffectMaterialSidebar;
    NSTextField *library = Label(@"工作区", 15, NSFontWeightSemibold, NSColor.labelColor);
    NSView *sideHeader = [NSView new];
    [sideHeader addSubview:library];
    [sideHeader addSubview:self.create];
    library.translatesAutoresizingMaskIntoConstraints = NO;
    self.create.translatesAutoresizingMaskIntoConstraints = NO;
    NSStackView *side = Stack(@[sideHeader, scroll], YES, 8);
    [sidebar addSubview:side];
    [NSLayoutConstraint activateConstraints:@[
        [sideHeader.widthAnchor constraintEqualToAnchor:side.widthAnchor],
        [sideHeader.heightAnchor constraintEqualToConstant:27],
        [library.leadingAnchor constraintEqualToAnchor:sideHeader.leadingAnchor constant:4],
        [library.centerYAnchor constraintEqualToAnchor:sideHeader.centerYAnchor],
        [self.create.trailingAnchor constraintEqualToAnchor:sideHeader.trailingAnchor],
        [self.create.centerYAnchor constraintEqualToAnchor:sideHeader.centerYAnchor],
        [side.leadingAnchor constraintEqualToAnchor:sidebar.leadingAnchor constant:8],
        [side.trailingAnchor constraintEqualToAnchor:sidebar.trailingAnchor constant:-8],
        [side.topAnchor constraintEqualToAnchor:sidebar.topAnchor constant:8],
        [side.bottomAnchor constraintEqualToAnchor:sidebar.bottomAnchor constant:-12],
        [scroll.widthAnchor constraintEqualToAnchor:side.widthAnchor]
    ]];
    [scroll setContentHuggingPriority:1 forOrientation:NSLayoutConstraintOrientationVertical];

    NSView *detail = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, size.width - 190, size.height)];
    self.pageView = [[OBPageView alloc] initWithCall:self.call];
    self.pageView.translatesAutoresizingMaskIntoConstraints = NO;
    NSView *top = [NSView new];
    top.translatesAutoresizingMaskIntoConstraints = NO;
    NSStackView *navigation = Stack(@[self.back, self.forward, self.reload, self.home], NO, 2);
    NSStackView *actions = Stack(@[self.control, self.tabButton, self.splitButton, self.more], NO, 5);
    self.address.translatesAutoresizingMaskIntoConstraints = NO;
    [top addSubview:navigation];
    [top addSubview:self.address];
    [top addSubview:actions];
    [detail addSubview:top];
    NSBox *rule = [NSBox new];
    rule.boxType = NSBoxSeparator;
    rule.translatesAutoresizingMaskIntoConstraints = NO;
    [detail addSubview:rule];

    NSView *viewport = [NSView new];
    viewport.translatesAutoresizingMaskIntoConstraints = NO;
    [detail addSubview:viewport];
    self.secondaryPageView = [[OBPageView alloc] initWithCall:self.call];
    self.secondaryPageView.translatesAutoresizingMaskIntoConstraints = NO;
    self.pageSplit = [NSSplitView new];
    self.pageSplit.translatesAutoresizingMaskIntoConstraints = NO;
    self.pageSplit.vertical = NO;
    self.pageSplit.dividerStyle = NSSplitViewDividerStyleThin;
    [self.pageSplit addArrangedSubview:self.pageView];
    [self.pageSplit addArrangedSubview:self.secondaryPageView];
    self.secondaryPageView.hidden = YES;
    [viewport addSubview:self.pageSplit];
    self.emptyTitle = Label(@"打开工作区", 24, NSFontWeightSemibold, NSColor.labelColor);
    self.emptyAction = [self button:@"新建工作区" action:@selector(emptyAction:)];
    NSImageView *icon = [NSImageView imageViewWithImage:NSApp.applicationIconImage];
    [icon.widthAnchor constraintEqualToConstant:40].active = YES;
    [icon.heightAnchor constraintEqualToConstant:40].active = YES;
    self.emptyView = Stack(@[icon, self.emptyTitle, self.emptyAction], YES, 12);
    self.emptyView.alignment = NSLayoutAttributeCenterX;
    [viewport addSubview:self.emptyView];

    NSBox *lowerRule = [NSBox new];
    lowerRule.boxType = NSBoxSeparator;
    lowerRule.translatesAutoresizingMaskIntoConstraints = NO;
    [detail addSubview:lowerRule];
    NSStackView *bottom = Stack(@[self.notice, self.status], YES, 3);
    [detail addSubview:bottom];

    [NSLayoutConstraint activateConstraints:@[
        [top.leadingAnchor constraintEqualToAnchor:detail.leadingAnchor constant:8],
        [top.trailingAnchor constraintEqualToAnchor:detail.trailingAnchor constant:-8],
        [top.topAnchor constraintEqualToAnchor:detail.topAnchor constant:6],
        [top.heightAnchor constraintEqualToConstant:26],
        [navigation.leadingAnchor constraintEqualToAnchor:top.leadingAnchor],
        [navigation.centerYAnchor constraintEqualToAnchor:top.centerYAnchor],
        [navigation.widthAnchor constraintEqualToConstant:108],
        [self.address.leadingAnchor constraintEqualToAnchor:navigation.trailingAnchor constant:8],
        [self.address.trailingAnchor constraintEqualToAnchor:actions.leadingAnchor constant:-8],
        [self.address.centerYAnchor constraintEqualToAnchor:top.centerYAnchor],
        [self.address.heightAnchor constraintEqualToConstant:26],
        [actions.trailingAnchor constraintEqualToAnchor:top.trailingAnchor],
        [actions.centerYAnchor constraintEqualToAnchor:top.centerYAnchor],
        [actions.widthAnchor constraintEqualToConstant:182],
        [rule.topAnchor constraintEqualToAnchor:top.bottomAnchor constant:6],
        [rule.leadingAnchor constraintEqualToAnchor:detail.leadingAnchor],
        [rule.trailingAnchor constraintEqualToAnchor:detail.trailingAnchor],
        [viewport.topAnchor constraintEqualToAnchor:rule.bottomAnchor],
        [viewport.leadingAnchor constraintEqualToAnchor:detail.leadingAnchor],
        [viewport.trailingAnchor constraintEqualToAnchor:detail.trailingAnchor],
        [viewport.bottomAnchor constraintEqualToAnchor:lowerRule.topAnchor],
        [self.pageSplit.topAnchor constraintEqualToAnchor:viewport.topAnchor],
        [self.pageSplit.bottomAnchor constraintEqualToAnchor:viewport.bottomAnchor],
        [self.pageSplit.leadingAnchor constraintEqualToAnchor:viewport.leadingAnchor],
        [self.pageSplit.trailingAnchor constraintEqualToAnchor:viewport.trailingAnchor],
        [self.emptyView.centerXAnchor constraintEqualToAnchor:viewport.centerXAnchor],
        [self.emptyView.centerYAnchor constraintEqualToAnchor:viewport.centerYAnchor],
        [lowerRule.leadingAnchor constraintEqualToAnchor:detail.leadingAnchor],
        [lowerRule.trailingAnchor constraintEqualToAnchor:detail.trailingAnchor],
        [bottom.topAnchor constraintEqualToAnchor:lowerRule.bottomAnchor constant:7],
        [bottom.leadingAnchor constraintEqualToAnchor:detail.leadingAnchor constant:16],
        [bottom.trailingAnchor constraintEqualToAnchor:detail.trailingAnchor constant:-16],
        [bottom.bottomAnchor constraintEqualToAnchor:detail.bottomAnchor constant:-7],
        [self.status.widthAnchor constraintEqualToAnchor:bottom.widthAnchor],
        [self.notice.widthAnchor constraintEqualToAnchor:bottom.widthAnchor]
    ]];

    NSViewController *sideController = [NSViewController new];
    sideController.view = sidebar;
    NSViewController *pageController = [NSViewController new];
    pageController.view = detail;
    NSSplitViewController *split = [NSSplitViewController new];
    split.splitView.vertical = YES;
    split.splitView.dividerStyle = NSSplitViewDividerStyleThin;
    NSSplitViewItem *left = [NSSplitViewItem splitViewItemWithViewController:sideController];
    left.minimumThickness = 148;
    left.maximumThickness = 300;
    left.canCollapse = NO;
    left.holdingPriority = NSLayoutPriorityDefaultHigh;
    [split addSplitViewItem:left];
    NSSplitViewItem *right = [NSSplitViewItem splitViewItemWithViewController:pageController];
    right.minimumThickness = 450;
    [split addSplitViewItem:right];
    self.window.contentViewController = split;
    [self.window setContentSize:size];
    [split.splitView setPosition:190 ofDividerAtIndex:0];
    [self.window center];
    [self.window setFrameAutosaveName:@"open-browser.main-window"];
    [self displayWorkspaces:@[]];
}

- (void)emptyAction:(id)sender { [self.window makeFirstResponder:self.address]; }

- (void)show {
    [NSApp activateIgnoringOtherApps:YES];
    [self.window makeKeyAndOrderFront:nil];
    [self render];
    [self refresh];
    if (!self.timer) {
        __weak typeof(self) weakSelf = self;
        self.timer = [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer *timer) {
            typeof(self) owner = weakSelf;
            if (!owner) { [timer invalidate]; return; }
            if (owner.window.visible) [owner refresh];
        }];
    }
}

- (void)invoke:(NSString *)method params:(NSDictionary *)params reply:(WorkspaceReply)reply {
    self.call(method, params, ^(id result, NSString *error) {
        dispatch_async(dispatch_get_main_queue(), ^{ reply(result, error); });
    });
}

- (void)message:(NSString *)message {
    self.notice.stringValue = message ?: @"";
    self.notice.hidden = !message.length;
    self.notice.toolTip = message;
}

- (void)refresh {
    if (self.refreshing) return;
    self.refreshing = YES;
    NSUInteger revision = self.revision;
    [self invoke:@"listWorkspaces" params:@{} reply:^(id result, NSString *error) {
        self.refreshing = NO;
        if (revision != self.revision) { [self refresh]; return; }
        BOOL wasConnected = self.connected;
        self.connected = !error && [result isKindOfClass:NSArray.class];
        if (!self.connected) {
            [self message:error ?: @"正在连接本地服务…"];
            [self render];
            return;
        }
        if (!wasConnected) [self message:nil];
        [self displayWorkspaces:result];
    }];
}

- (void)displayWorkspaces:(NSArray *)items {
    self.workspaces = items;
    NSSet *ids = [NSSet setWithArray:[items valueForKey:@"workspaceId"]];
    [self.collapsed intersectSet:ids];
    for (NSString *wid in self.drafts.allKeys) if (![ids containsObject:wid]) [self.drafts removeObjectForKey:wid];
    if (self.pendingSelection) {
        NSDictionary *created = Find(items, @"workspaceId", self.pendingSelection[@"workspaceId"]);
        if (created) {
            self.workspaceID = created[@"workspaceId"];
            self.pageID = self.pendingSelection[@"pageId"];
            [self.collapsed removeObject:self.workspaceID];
            self.pendingSelection = nil;
        }
    }
    if (!Find(items, @"workspaceId", self.workspaceID)) {
        self.workspaceID = items.firstObject[@"workspaceId"];
        self.pageID = nil;
    }
    NSDictionary *selectedWorkspace = [self active];
    if (![self page] && ![self draft]) {
        self.pageID = [selectedWorkspace[@"pages"] lastObject][@"pageId"] ?: [self.drafts[self.workspaceID ?: @""] lastObject][@"pageId"];
    }
    NSArray *titles = @[@"待处理", @"Agent 运行", @"人工接管", @"待命"];
    NSMutableArray *rows = [NSMutableArray array];
    for (NSInteger i = 0; i < (NSInteger)titles.count; i++) {
        NSMutableArray *members = [NSMutableArray array];
        for (NSDictionary *w in items) if (Group(w) == i) [members addObject:w];
        if (!members.count) continue;
        [rows addObject:@{@"group":titles[i], @"count":@(members.count)}];
        for (NSDictionary *member in members) {
            [rows addObject:member];
            if (![self.collapsed containsObject:member[@"workspaceId"]]) {
                [rows addObjectsFromArray:member[@"pages"] ?: @[]];
                [rows addObjectsFromArray:self.drafts[member[@"workspaceId"]] ?: @[]];
            }
        }
    }
    self.syncingSelection = YES;
    if (![self.rows isEqual:rows]) {
        self.rows = rows;
        [self.table reloadData];
    }
    NSDictionary *selected = [self.collapsed containsObject:self.workspaceID ?: @""] ? selectedWorkspace : ([self page] ?: [self draft] ?: selectedWorkspace);
    if (selected) {
        NSUInteger index = [self.rows indexOfObject:selected];
        if (index != NSNotFound && self.table.selectedRow != (NSInteger)index)
            [self.table selectRowIndexes:[NSIndexSet indexSetWithIndex:index] byExtendingSelection:NO];
    } else {
        [self.table deselectAll:nil];
    }
    self.syncingSelection = NO;
    [self render];
    [self readLocation];
}

- (NSInteger)numberOfRowsInTableView:(NSTableView *)table { return self.rows.count; }
- (BOOL)tableView:(NSTableView *)table isGroupRow:(NSInteger)row { return self.rows[row][@"group"] != nil; }
- (BOOL)tableView:(NSTableView *)table shouldSelectRow:(NSInteger)row { return self.rows[row][@"workspaceId"] != nil; }
- (CGFloat)tableView:(NSTableView *)table heightOfRow:(NSInteger)row { return self.rows[row][@"group"] ? 22 : 25; }

- (NSView *)tableView:(NSTableView *)table viewForTableColumn:(NSTableColumn *)column row:(NSInteger)row {
    NSDictionary *item = self.rows[row];
    BOOL group = item[@"group"] != nil;
    NSTableCellView *cell = [[NSTableCellView alloc] init];
    BOOL page = item[@"pageId"] != nil;
    NSString *title = String(item[@"title"]), *origin = String(item[@"origin"]);
    NSString *workspaceName = String(item[@"name"]);
    if (!workspaceName.length) workspaceName = @"未命名任务（请命名）";
    NSString *name = group ? [NSString stringWithFormat:@"%@   %@", item[@"group"], item[@"count"]]
        : page ? (title.length ? title : origin) : workspaceName;
    NSTextField *primary = Label(name, group ? 11 : 13, group || !page ? NSFontWeightSemibold : NSFontWeightRegular, group ? NSColor.secondaryLabelColor : NSColor.labelColor);
    cell.textField = primary;
    BOOL workspace = !group && !page;
    if (workspace) {
        BOOL collapsed = [self.collapsed containsObject:item[@"workspaceId"]];
        NSButton *toggle = [NSButton buttonWithTitle:@"" target:self action:@selector(toggleWorkspace:)];
        toggle.bordered = NO;
        toggle.imagePosition = NSImageOnly;
        toggle.image = [NSImage imageWithSystemSymbolName:collapsed ? @"chevron.right" : @"chevron.down" accessibilityDescription:nil];
        toggle.symbolConfiguration = [NSImageSymbolConfiguration configurationWithPointSize:9 weight:NSFontWeightSemibold];
        toggle.identifier = item[@"workspaceId"];
        toggle.toolTip = collapsed ? @"展开工作区" : @"折叠工作区";
        [toggle setAccessibilityLabel:toggle.toolTip];
        toggle.translatesAutoresizingMaskIntoConstraints = NO;
        [cell addSubview:toggle];
        [NSLayoutConstraint activateConstraints:@[
            [toggle.leadingAnchor constraintEqualToAnchor:cell.leadingAnchor],
            [toggle.centerYAnchor constraintEqualToAnchor:cell.centerYAnchor],
            [toggle.widthAnchor constraintEqualToConstant:15]
        ]];
        cell.toolTip = Status(item);
    } else if (page) {
        cell.toolTip = origin;
    }
    primary.translatesAutoresizingMaskIntoConstraints = NO;
    [cell addSubview:primary];
    [NSLayoutConstraint activateConstraints:@[
        [primary.leadingAnchor constraintEqualToAnchor:cell.leadingAnchor constant:group ? 0 : page ? 22 : 16],
        [primary.trailingAnchor constraintEqualToAnchor:cell.trailingAnchor constant:-2],
        [primary.centerYAnchor constraintEqualToAnchor:cell.centerYAnchor]
    ]];
    return cell;
}

- (void)toggleWorkspace:(NSButton *)sender {
    NSString *wid = sender.identifier;
    if ([self.collapsed containsObject:wid]) [self.collapsed removeObject:wid];
    else [self.collapsed addObject:wid];
    [self displayWorkspaces:self.workspaces];
}

- (void)tableViewSelectionDidChange:(NSNotification *)note {
    NSInteger index = self.table.selectedRow;
    if (self.syncingSelection || index < 0 || index >= (NSInteger)self.rows.count) return;
    NSDictionary *item = self.rows[index];
    NSString *workspaceID = item[@"workspaceId"];
    if (!workspaceID) return;
    BOOL same = [workspaceID isEqual:self.workspaceID];
    self.workspaceID = workspaceID;
    self.pageID = item[@"pageId"] ?: (same ? self.pageID : nil);
    [self message:nil];
    [self displayWorkspaces:self.workspaces];
}

- (NSDictionary *)active { return Find(self.workspaces, @"workspaceId", self.workspaceID); }
- (NSDictionary *)page { return Find([self active][@"pages"], @"pageId", self.pageID); }
- (NSDictionary *)draft { return Find(self.drafts[self.workspaceID ?: @""], @"pageId", self.pageID); }
- (NSDictionary *)handle { return [self page] ? @{@"workspaceId":self.workspaceID, @"pageId":self.pageID} : nil; }
- (NSDictionary *)splitCandidate {
    for (NSDictionary *item in [self active][@"pages"])
        if (![item[@"pageId"] isEqual:self.pageID]) return item;
    return nil;
}

- (void)render {
    NSDictionary *w = [self active], *activity = w[@"activity"], *page = [self page];
    BOOL agent = [w[@"mode"] isEqual:@"agent"], human = [w[@"mode"] isEqual:@"human"];
    BOOL ready = self.connected && !self.busy;
    self.window.title = String(page[@"title"]).length ? page[@"title"] : @"open-browser";
    NSString *key = self.pageID ?: self.workspaceID ?: @"";
    if (![key isEqual:self.addressIdentity]) {
        self.addressIdentity = key;
        self.addressEdited = NO;
        self.currentURL = @"";
        self.address.stringValue = @"";
        self.canGoBack = self.canGoForward = NO;
    }
    self.address.enabled = self.connected;
    self.back.enabled = ready && self.canGoBack;
    self.forward.enabled = ready && self.canGoForward;
    self.reload.enabled = ready && page;
    self.home.enabled = ready;
    self.tabButton.enabled = ready;
    self.splitButton.enabled = ready && page && ([self splitCandidate] || self.splitPage);
    self.splitButton.toolTip = self.splitPage ? @"关闭拆分" : @"拆分当前工作区页面";
    self.more.enabled = ready;
    self.create.enabled = ready;
    self.control.enabled = ready && (human || (agent && page));
    self.control.title = human ? @"交回 Agent" : @"接管";
    self.control.toolTip = human ? @"交回此工作区的控制权" : @"人工接管当前页面";
    self.control.hidden = !w || (!page && !human);
    self.status.stringValue = w ? Status(w) : self.connected ? @"" : @"正在连接本地服务…";
    if ([activity[@"queued"] integerValue]) self.status.stringValue = [self.status.stringValue stringByAppendingFormat:@" · 排队 %@", activity[@"queued"]];
    self.status.toolTip = Operation(Map(activity[@"recent"]));
    self.credential.title = [activity[@"needsCredential"] boolValue] ? @"补充凭据…" : @"绑定凭据…";
    self.credential.enabled = agent && page;
    self.preview.enabled = agent && page;
    self.feedback.enabled = self.connected;
    self.closePageButton.enabled = page || [self draft];
    self.close.enabled = agent;

    NSDictionary *handle = self.connected && page ? [self handle] : nil;
    self.emptyView.hidden = handle != nil;
    self.pageView.hidden = !handle;
    NSDictionary *second = self.splitPage;
    if (second && (![Find([self active][@"pages"], @"pageId", second[@"pageId"]) isKindOfClass:NSDictionary.class] ||
                    [second[@"pageId"] isEqual:self.pageID])) second = nil;
    if (!second) self.splitPage = nil;
    NSDictionary *secondHandle = second ? @{@"workspaceId":self.workspaceID, @"pageId":second[@"pageId"]} : nil;
    self.secondaryPageView.hidden = secondHandle == nil || handle == nil;
    self.pageSplit.hidden = handle == nil;
    self.emptyTitle.stringValue = !self.connected ? @"正在连接本地服务…" : @"新标签页";
    self.emptyAction.title = @"输入网址";
    self.emptyAction.enabled = ready;
    if (!self.window.visible || self.window.miniaturized) handle = nil;
    NSArray *identity = handle ? @[handle, String(w[@"mode"]), String(w[@"controlGeneration"])] : @[];
    if (![self.displayedPage isEqual:identity]) {
        self.displayedPage = identity;
        [self.pageView displayPage:handle mode:String(w[@"mode"]) generation:String(w[@"controlGeneration"])];
    }
    [self.secondaryPageView displayPage:secondHandle mode:String(w[@"mode"]) generation:String(w[@"controlGeneration"])];
    if ((!agent || !self.connected) && self.previewSheet) [self.window endSheet:self.previewSheet.window];
    if ((!agent || !self.connected) && self.credentialSheet) [self.window endSheet:self.credentialSheet.window returnCode:NSModalResponseCancel];
}

- (void)windowWillClose:(NSNotification *)notification {
    self.displayedPage = @[];
    [self.pageView displayPage:nil mode:@"" generation:@""];
    [self.secondaryPageView displayPage:nil mode:@"" generation:@""];
}

- (void)windowDidMiniaturize:(NSNotification *)notification { [self render]; }
- (void)windowDidDeminiaturize:(NSNotification *)notification { [self render]; [self refresh]; }

- (void)perform:(NSString *)method params:(NSDictionary *)params success:(void (^)(id))success {
    if (!params || self.busy) return;
    self.busy = YES;
    [self message:nil];
    [self render];
    [self invoke:method params:params reply:^(id result, NSString *error) {
        self.busy = NO;
        if (error.length) {
            NSDictionary *messages = @{@"invalid_url":@"请输入完整的 http 或 https 网址。",
                @"origin_denied":@"该站点不在此工作区的授权范围内。",
                @"navigation_failed":@"页面打开失败，请检查网址或网络。",
                @"workspace_under_user_control":@"工作区正由用户控制。",
                @"stale_control":@"控制权已变化，请重新操作。",
                @"stale_credential_request":@"凭据请求已变化，请重新查看。"};
            [self message:messages[error] ?: error];
        }
        else {
            self.revision++;
            if (success) success(result);
        }
        [self render];
        [self refresh];
    }];
}

- (NSAlert *)sheet:(NSString *)title message:(NSString *)message action:(NSString *)action {
    NSAlert *sheet = [[NSAlert alloc] init];
    sheet.messageText = title;
    sheet.informativeText = message ?: @"";
    [sheet addButtonWithTitle:action];
    [sheet addButtonWithTitle:@"取消"];
    return sheet;
}

- (NSTextField *)field:(NSString *)placeholder secure:(BOOL)secure {
    NSTextField *field = secure ? [[NSSecureTextField alloc] initWithFrame:NSZeroRect] : [[NSTextField alloc] initWithFrame:NSZeroRect];
    field.placeholderString = placeholder;
    [field setAccessibilityLabel:placeholder];
    [field.widthAnchor constraintEqualToConstant:285].active = YES;
    return field;
}

- (void)attach:(NSArray<NSView *> *)views sheet:(NSAlert *)sheet {
    NSStackView *stack = Stack(views, YES, 7);
    stack.frame = NSMakeRect(0, 0, 285, stack.fittingSize.height);
    sheet.accessoryView = stack;
}

- (void)createWorkspace:(id)sender {
    NSAlert *sheet = [self sheet:@"新建工作区" message:@"" action:@"创建"];
    NSTextField *name = [self field:@"工作区名称" secure:NO];
    NSTextField *url = [self field:@"首个网址（可选）" secure:NO];
    [self attach:@[name, url] sheet:sheet];
    name.nextKeyView = url;
    sheet.window.initialFirstResponder = name;
    [sheet beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        if (response != NSAlertFirstButtonReturn) return;
        NSString *title = [name.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        NSString *address = [url.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (!title.length) { [self message:@"请输入工作区名称。"]; return; }
        [self perform:@"createWorkspace" params:@{@"name":title} success:^(id result) {
            NSString *createdID = result[@"workspaceId"];
            self.pendingSelection = @{@"workspaceId":createdID};
            if (address.length) [self openAddress:address workspace:createdID];
        }];
    }];
}

- (void)openAddress:(NSString *)address workspace:(NSString *)workspace {
    NSDictionary *draft = [self draft];
    [self perform:@"pageNew" params:@{@"workspaceId":workspace, @"url":address} success:^(id result) {
        if (draft) [self.drafts[workspace] removeObject:draft];
        self.pendingSelection = result;
    }];
}

- (void)focusAddress:(id)sender {
    [self.window makeFirstResponder:self.address];
    [self.address selectText:nil];
}

- (void)newTab:(id)sender {
    if (!self.connected || self.busy) return;
    if (self.workspaceID) {
        if (!self.drafts[self.workspaceID]) self.drafts[self.workspaceID] = [NSMutableArray array];
        self.pageID = NSUUID.UUID.UUIDString;
        [self.drafts[self.workspaceID] addObject:@{@"workspaceId":self.workspaceID, @"pageId":self.pageID, @"title":@"新标签页"}];
        [self.collapsed removeObject:self.workspaceID];
        [self displayWorkspaces:self.workspaces];
    }
    [self focusAddress:nil];
}

- (void)home:(id)sender {
    self.splitPage = nil;
    [self newTab:sender];
}

- (void)toggleSplit:(id)sender {
    if (self.splitPage) {
        self.splitPage = nil;
        [self render];
        return;
    }
    NSDictionary *candidate = [self splitCandidate];
    if (!candidate) {
        [self message:@"当前工作区至少需要两个页面才能拆分。"];
        return;
    }
    self.splitPage = candidate;
    [self render];
}

- (void)controlTextDidChange:(NSNotification *)note {
    if (note.object == self.address) self.addressEdited = YES;
}

- (BOOL)control:(NSControl *)control textView:(NSTextView *)view doCommandBySelector:(SEL)selector {
    if (control == self.address && selector == @selector(cancelOperation:)) {
        self.addressEdited = NO;
        self.address.stringValue = self.currentURL ?: @"";
        [self.window makeFirstResponder:self.table];
        return YES;
    }
    return NO;
}

- (void)applyLocation:(NSDictionary *)location {
    self.currentURL = String(location[@"url"]);
    self.canGoBack = [location[@"canGoBack"] boolValue];
    self.canGoForward = [location[@"canGoForward"] boolValue];
    if (!self.addressEdited && ![self.address.stringValue isEqual:self.currentURL]) self.address.stringValue = self.currentURL;
    [self render];
}

- (void)readLocation {
    NSDictionary *handle = [self handle];
    if (!self.connected || !handle || [handle isEqual:self.locationPending]) return;
    self.locationPending = handle;
    NSUInteger revision = self.revision;
    [self invoke:@"pageLocation" params:handle reply:^(id result, NSString *error) {
        if (self.locationPending == handle) self.locationPending = nil;
        if (!error && revision == self.revision && [handle isEqual:[self handle]]) [self applyLocation:result];
    }];
}

- (void)navigate:(NSString *)action url:(NSString *)url {
    NSDictionary *handle = [self handle];
    if (!handle) return;
    NSMutableDictionary *params = [handle mutableCopy];
    params[@"action"] = action;
    if (url) params[@"url"] = url;
    [self perform:@"pageNavigate" params:params success:^(id result) {
        if ([handle isEqual:[self handle]]) {
            self.addressEdited = NO;
            [self applyLocation:result];
        }
    }];
}

- (void)goBack:(id)sender { if (self.back.enabled) [self navigate:@"back" url:nil]; }
- (void)goForward:(id)sender { if (self.forward.enabled) [self navigate:@"forward" url:nil]; }
- (void)reloadPage:(id)sender { if (self.reload.enabled) [self navigate:@"reload" url:nil]; }

- (void)submitAddress:(id)sender {
    if (!self.connected || self.busy) return;
    NSString *address = [self.address.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (!address.length) return;
    if ([address rangeOfString:@"://"].location == NSNotFound) {
        NSRange local = [address rangeOfString:@"^(localhost|127\\.0\\.0\\.1|\\[::1\\])([:/?#]|$)" options:NSRegularExpressionSearch|NSCaseInsensitiveSearch];
        address = [(local.location == 0 ? @"http://" : @"https://") stringByAppendingString:address];
    }
    NSURLComponents *components = [NSURLComponents componentsWithString:address];
    if (![@[@"http", @"https"] containsObject:components.scheme.lowercaseString] || !components.host.length || components.user || components.password) {
        [self message:@"请输入有效的 HTTP 或 HTTPS 网址。"]; return;
    }
    if ([self handle]) { [self navigate:@"go" url:address]; return; }
    if (self.workspaceID) { [self openAddress:address workspace:self.workspaceID]; return; }
    [self perform:@"createWorkspace" params:@{@"name":components.host} success:^(id result) {
        NSString *wid = result[@"workspaceId"];
        self.pendingSelection = @{@"workspaceId":wid};
        [self openAddress:address workspace:wid];
    }];
}

- (void)changeControl:(id)sender {
    if ([[self active][@"mode"] isEqual:@"human"]) {
        [self perform:@"returnToAgent" params:@{@"workspaceId":self.workspaceID} success:nil];
    } else {
        [self perform:@"takeControl" params:[self handle] success:nil];
    }
}

- (void)closePage:(id)sender {
    if ([self draft]) {
        [self.drafts[self.workspaceID] removeObject:[self draft]];
        self.pageID = nil;
        [self displayWorkspaces:self.workspaces];
    } else [self perform:@"closePage" params:[self handle] success:nil];
}

- (void)feedback:(id)sender {
    NSDictionary *workspace = [self active];
    NSDictionary *activity = workspace[@"activity"];
    NSString *report = [NSString stringWithFormat:@"open-browser\n工作区状态：%@\nAgent：%@\n页面标题：%@\n\n请补充复现步骤。此文本不包含网址、页面正文、凭据或 Cookie。",
        Status(workspace), String(workspace[@"agentName"]), String([self page][@"title"])];
    NSAlert *alert = [NSAlert new];
    alert.messageText = @"反馈问题";
    alert.informativeText = [NSString stringWithFormat:@"%@\n当前操作：%@", report, Operation(Map(activity[@"recent"]))];
    [alert addButtonWithTitle:@"复制脱敏反馈"];
    [alert addButtonWithTitle:@"关闭"];
    if ([alert runModal] == NSAlertFirstButtonReturn) {
        NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
        [pasteboard clearContents];
        [pasteboard setString:report forType:NSPasteboardTypeString];
        [self message:@"已复制脱敏反馈，可粘贴到项目 issue 或私聊中。"];
    }
}

- (void)closeWorkspace:(id)sender {
    NSString *workspace = self.workspaceID;
    if (!workspace) return;
    NSAlert *sheet = [self sheet:@"关闭工作区？" message:[self active][@"name"] action:@"关闭工作区"];
    sheet.buttons.firstObject.hasDestructiveAction = YES;
    [sheet beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        if (response == NSAlertFirstButtonReturn) [self perform:@"closeWorkspace" params:@{@"workspaceId":workspace} success:nil];
    }];
}

- (void)previewPage:(id)sender {
    NSDictionary *page = [self handle];
    [self perform:@"previewPage" params:page success:^(id result) {
        if (![page isEqual:[self handle]] || ![[self active][@"mode"] isEqual:@"agent"]) return;
        NSAlert *sheet = [[NSAlert alloc] init];
        sheet.messageText = @"页面文本";
        sheet.informativeText = String([self page][@"origin"]);
        [sheet addButtonWithTitle:@"完成"];
        NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 320, 200)];
        scroll.hasVerticalScroller = YES;
        scroll.borderType = NSBezelBorder;
        NSTextView *text = [[NSTextView alloc] initWithFrame:scroll.contentView.bounds];
        text.editable = NO;
        text.richText = NO;
        text.autoresizingMask = NSViewWidthSizable;
        text.textContainerInset = NSMakeSize(6, 6);
        text.string = String(result[@"text"]).length ? result[@"text"] : @"暂无可预览的文字。";
        scroll.documentView = text;
        sheet.accessoryView = scroll;
        self.previewSheet = sheet;
        [sheet beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse __unused response) {
            text.string = @"";
            self.previewSheet = nil;
        }];
    }];
}

- (void)credentials:(id)sender {
    NSDictionary *page = [self handle];
    if (!page) return;
    [self perform:@"getWorkspace" params:@{@"workspaceId":page[@"workspaceId"]} success:^(id result) {
        if (![page isEqual:[self handle]] || ![result[@"mode"] isEqual:@"agent"]) return;
        NSDictionary *request = Map(result[@"activity"][@"credentialRequest"]);
        NSString *target = request ? request[@"pageId"] : page[@"pageId"];
        NSDictionary *targetPage = Find(result[@"pages"], @"pageId", target);
        NSString *origin = request ? String(request[@"origin"]) : String(targetPage[@"origin"]);
        if (!targetPage || ![targetPage[@"origin"] isEqual:origin]) { [self message:@"页面已变化，请重新打开凭据面板。"]; return; }
        [self editCredential:request page:targetPage generation:result[@"controlGeneration"] origin:origin];
    }];
}

- (void)editCredential:(NSDictionary *)request page:(NSDictionary *)page generation:(NSString *)generation origin:(NSString *)origin {
    NSDictionary *handle = @{@"workspaceId":page[@"workspaceId"], @"pageId":page[@"pageId"]};
    NSAlert *sheet = [self sheet:request ? @"补充凭据" : @"绑定凭据" message:origin action:@"绑定"];
    NSTextField *ref = [self field:@"凭据名称" secure:NO];
    NSSecureTextField *secret = (NSSecureTextField *)[self field:@"凭据值" secure:YES];
    NSMutableArray *fields = [NSMutableArray array];
    if (request) {
        ref.stringValue = String(request[@"credentialRef"]);
        [fields addObject:Label(ref.stringValue, 13, NSFontWeightMedium, NSColor.labelColor)];
    } else {
        [fields addObject:ref];
        ref.nextKeyView = secret;
    }
    [fields addObject:secret];
    [self attach:fields sheet:sheet];
    sheet.window.initialFirstResponder = request ? secret : ref;
    self.credentialSheet = sheet;
    self.secretField = secret;
    [sheet beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        self.credentialSheet = nil;
        self.secretField = nil;
        NSString *value = [secret.stringValue copy];
        secret.stringValue = @"";
        if (response != NSAlertFirstButtonReturn) return;
        NSString *key = [ref.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        if (!value.length || !key.length) { [self message:@"请填写凭据名称和值。"]; return; }
        [self perform:@"getWorkspace" params:@{@"workspaceId":handle[@"workspaceId"]} success:^(id fresh) {
            NSDictionary *currentRequest = Map(fresh[@"activity"][@"credentialRequest"]);
            NSDictionary *currentPage = Find(fresh[@"pages"], @"pageId", handle[@"pageId"]);
            if (![fresh[@"mode"] isEqual:@"agent"] || ![generation isEqual:fresh[@"controlGeneration"]] ||
                ![currentPage[@"origin"] isEqual:origin] || (request && ![request isEqual:currentRequest])) {
                [self message:@"页面、控制权或凭据请求已变化，请重新查看。"];
                return;
            }
            NSMutableDictionary *binding = [NSMutableDictionary dictionaryWithDictionary:request ?: @{}];
            [binding addEntriesFromDictionary:@{@"workspaceId":handle[@"workspaceId"], @"origin":origin, @"credentialRef":key, @"value":value}];
            [self perform:(request ? @"resolveCredential" : @"setCredential") params:binding success:^(id __unused bound) {
                [self message:request ? @"已绑定凭据，调用方可以重试。" : @"已绑定凭据。"];
            }];
        }];
    }];
}

@end
