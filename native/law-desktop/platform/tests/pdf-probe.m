// Run only against synthetic content. This probe never accesses the keychain.
// Compile with macos.m and Cocoa, WebKit, Security, LocalAuthentication, PDFKit.
#import <Cocoa/Cocoa.h>
#import <PDFKit/PDFKit.h>

extern void law_pdf_start(const char *, const char *, void (*)(void *, const char *), void *, uint64_t);
extern void law_pdf_cancel(uint64_t);

static NSString *outputPath;
static unsigned int cancelledCount;
static void cancelled(void *context, const char *error) {
    if (!error || ++cancelledCount != 1) { fprintf(stderr, "Native PDF cancellation callback failed\n"); exit(1); }
}
static void completed(void *context, const char *error) {
    if (error) { fprintf(stderr, "%s\n", error); exit(1); }
    PDFDocument *document = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:outputPath]];
    NSString *text = document.string;
    NSString *compact = [[text componentsSeparatedByCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] componentsJoinedByString:@""];
    BOOL textPresent = [text containsString:@"合同审核报告"] && [text containsString:@"Contract review"]
        && [compact containsString:@"รายงานการตรวจสอบสัญญา"] && [text containsString:@"Page two"]
        && [text containsString:@"ข้ออ้างอิงต้นฉบับและแหล่งที่มา"];
    NSRect page = [[document pageAtIndex:0] boundsForBox:kPDFDisplayBoxMediaBox];
    if (cancelledCount != 1 || document.pageCount != 2 || !textPresent || fabs(page.size.width - 595.0) > 1.0
        || fabs(page.size.height - 842.0) > 1.0) {
        fprintf(stderr, "Native PDF pagination, multilingual text or A4 verification failed: pages=%lu width=%f height=%f text=%s\n", document.pageCount, page.size.width, page.size.height, text.UTF8String); exit(1);
    }
    fprintf(stdout, "{\"pages\":2,\"pageSize\":\"A4\",\"languages\":[\"zh\",\"en\",\"th\"],\"cancelledCallbacks\":1,\"native\":true}\n");
    fflush(stdout);
    exit(0);
}
int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 4) { fprintf(stderr, "Usage: pdf-probe /private/synthetic-output.pdf /path/NotoSansThai-Regular.ttf /path/NotoSansThai-Bold.ttf\n"); return 2; }
        outputPath = [NSString stringWithUTF8String:argv[1]];
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSString *html = @"<!doctype html><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'; font-src data:\"><style>@page{size:A4}body{font:14px 'Noto Sans Thai','PingFang SC',sans-serif}h1{font-size:24px}.next{break-before:page}</style><h1>合同审核报告 / Contract review / รายงานการตรวจสอบสัญญา</h1><p>第一项风险：付款期限。 Payment must occur within thirty days. กำหนดชำระเงินภายในสามสิบวัน</p><section class='next'><h1>第二页 Page two หน้าที่สอง</h1><p>保留原文引用与法律依据。Original references remain available. ข้ออ้างอิงต้นฉบับและแหล่งที่มา</p></section>";
        NSData *regular = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]];
        NSData *bold = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[3]]];
        if (!regular || !bold) { fprintf(stderr, "Offline Thai fonts are missing\n"); return 2; }
        NSString *fonts = [NSString stringWithFormat:@"<style>@font-face{font-family:'Noto Sans Thai';font-weight:400;src:url(data:font/ttf;base64,%@)}@font-face{font-family:'Noto Sans Thai';font-weight:700;src:url(data:font/ttf;base64,%@)}</style>", [regular base64EncodedStringWithOptions:0], [bold base64EncodedStringWithOptions:0]];
        html = [html stringByAppendingString:fonts];
        dispatch_async(dispatch_get_main_queue(), ^{
            law_pdf_start(html.UTF8String, outputPath.UTF8String, cancelled, NULL, 11);
            law_pdf_cancel(11);
            law_pdf_cancel(11);
            law_pdf_start(html.UTF8String, outputPath.UTF8String, completed, NULL, 12);
            law_pdf_cancel(11); // A stale cancellation must not affect a new job.
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            law_pdf_cancel(12);
            fprintf(stderr, "Native PDF smoke timed out\n"); exit(1);
        });
        [NSApp run];
        return 1;
    }
}
