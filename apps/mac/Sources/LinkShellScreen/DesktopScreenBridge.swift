import CoreFoundation
import Foundation

public enum DesktopScreenBridge {
  public static func identifier(_ value: Any?) -> String? {
    guard let value = value as? String, value.utf8.count == 36, UUID(uuidString: value) != nil else { return nil }
    return value
  }
  public static func validMessage(_ value: [String: Any]) -> Bool {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return false }
    return data.count <= 262_144
  }
  public static func rect(_ value: Any?) -> CGRect? {
    guard let value = value as? [String: Any], let x = number(value["x"]), let y = number(value["y"]),
          let width = number(value["width"]), let height = number(value["height"]),
          abs(x) <= 16_384, abs(y) <= 16_384, (0...16_384).contains(width), (0...16_384).contains(height) else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
  }
  public static func integer(_ value: Any?) -> Int? {
    guard let number = number(value), number.rounded() == number, abs(number) <= 9_007_199_254_740_991 else { return nil }
    return Int(number)
  }
  public static func boolean(_ value: Any?) -> Bool? {
    guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return value.boolValue
  }
  private static func number(_ value: Any?) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
    return value.doubleValue
  }
}
