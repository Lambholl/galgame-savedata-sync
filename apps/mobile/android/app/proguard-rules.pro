# 在此添加项目专用的 ProGuard 规则。
# 可通过 build.gradle 中的 proguardFiles 设置
# 控制实际应用的配置文件集合。
#
# 详情请参阅
#   http://developer.android.com/guide/developing/tools/proguard.html

# 如果项目在 WebView 中使用 JavaScript，请取消以下规则的注释，
# 并将其中的类名替换为 JavaScript 接口类的
# 完全限定名称：
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# 取消以下规则的注释，以保留行号信息，
# 便于通过堆栈跟踪进行调试。
#-keepattributes SourceFile,LineNumberTable

# 如果保留行号信息，可取消以下规则的注释，
# 以隐藏原始源文件名。
#-renamesourcefileattribute SourceFile
