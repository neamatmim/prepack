/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import type { Binding } from "../environment.js";
import type { Bindings, BindingEntry, PropertyBindings, CreatedObjects, Realm } from "../realm.js";
import { construct_empty_effects, Effects } from "../realm.js";
import type { Descriptor, PropertyBinding } from "../types.js";

import {
  AbruptCompletion,
  BreakCompletion,
  Completion,
  ContinueCompletion,
  JoinedAbruptCompletions,
  JoinedNormalAndAbruptCompletions,
  SimpleNormalCompletion,
  NormalCompletion,
  ReturnCompletion,
  ThrowCompletion,
} from "../completions.js";
import { cloneDescriptor, equalDescriptors, IsDataDescriptor, StrictEqualityComparison } from "../methods/index.js";
import { Path } from "../singletons.js";
import { Generator } from "../utils/generator.js";
import { AbstractValue, ConcreteValue, EmptyValue, Value } from "../values/index.js";

import invariant from "../invariant.js";

function joinGenerators(joinCondition: AbstractValue, generator1: Generator, generator2: Generator): Generator {
  let realm = joinCondition.$Realm;
  let result = new Generator(realm, "joined", realm.pathConditions);
  if (!generator1.empty() || !generator2.empty()) {
    result.joinGenerators(joinCondition, generator1, generator2);
  }
  return result;
}

function joinArrays(
  realm: Realm,
  v1: void | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
  v2: void | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
  getAbstractValue: (void | Value, void | Value) => Value
): Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }> {
  let e = (v1 && v1[0]) || (v2 && v2[0]);
  if (e instanceof Value) return joinArraysOfValues(realm, (v1: any), (v2: any), getAbstractValue);
  else return joinArrayOfsMapEntries(realm, (v1: any), (v2: any), getAbstractValue);
}

function joinArrayOfsMapEntries(
  realm: Realm,
  a1: void | Array<{ $Key: void | Value, $Value: void | Value }>,
  a2: void | Array<{ $Key: void | Value, $Value: void | Value }>,
  getAbstractValue: (void | Value, void | Value) => Value
): Array<{ $Key: void | Value, $Value: void | Value }> {
  let empty = realm.intrinsics.empty;
  let n = Math.max((a1 && a1.length) || 0, (a2 && a2.length) || 0);
  let result = [];
  for (let i = 0; i < n; i++) {
    let { $Key: key1, $Value: val1 } = (a1 && a1[i]) || { $Key: empty, $Value: empty };
    let { $Key: key2, $Value: val2 } = (a2 && a2[i]) || { $Key: empty, $Value: empty };
    if (key1 === undefined && key2 === undefined) {
      result[i] = { $Key: undefined, $Value: undefined };
    } else {
      let key3 = getAbstractValue(key1, key2);
      let val3 = getAbstractValue(val1, val2);
      result[i] = { $Key: key3, $Value: val3 };
    }
  }
  return result;
}

function joinArraysOfValues(
  realm: Realm,
  a1: void | Array<Value>,
  a2: void | Array<Value>,
  getAbstractValue: (void | Value, void | Value) => Value
): Array<Value> {
  let n = Math.max((a1 && a1.length) || 0, (a2 && a2.length) || 0);
  let result = [];
  for (let i = 0; i < n; i++) {
    result[i] = getAbstractValue((a1 && a1[i]) || undefined, (a2 && a2[i]) || undefined);
  }
  return result;
}

export class JoinImplementation {
  composeCompletions(leftCompletion: void | Completion | Value, rightCompletion: Completion | Value): Completion {
    if (leftCompletion instanceof AbruptCompletion) return leftCompletion;
    if (leftCompletion instanceof JoinedNormalAndAbruptCompletions) {
      if (rightCompletion instanceof JoinedNormalAndAbruptCompletions) {
        rightCompletion.composedWith = leftCompletion;
        rightCompletion.pathConditionsAtCreation = leftCompletion.pathConditionsAtCreation;
        return rightCompletion;
      }
      let c = this.composeCompletions(leftCompletion.consequent, rightCompletion);
      if (c instanceof Value) c = new SimpleNormalCompletion(c);
      let a = this.composeCompletions(leftCompletion.alternate, rightCompletion);
      if (a instanceof Value) a = new SimpleNormalCompletion(a);
      let joinedCompletion = this.joinCompletions(leftCompletion.joinCondition, c, a);
      if (joinedCompletion instanceof JoinedNormalAndAbruptCompletions) {
        joinedCompletion.composedWith = leftCompletion.composedWith;
        joinedCompletion.pathConditionsAtCreation = leftCompletion.pathConditionsAtCreation;
        joinedCompletion.savedEffects = leftCompletion.savedEffects;
      }
      return joinedCompletion;
    }
    if (rightCompletion instanceof Value) rightCompletion = new SimpleNormalCompletion(rightCompletion);
    return rightCompletion;
  }

  composeWithEffects(completion: Completion, effects: Effects): Effects {
    if (completion instanceof AbruptCompletion) return construct_empty_effects(completion.value.$Realm, completion);
    if (completion instanceof SimpleNormalCompletion) return effects.shallowCloneWithResult(effects.result);
    invariant(completion instanceof JoinedNormalAndAbruptCompletions);
    let e1 = this.composeWithEffects(completion.consequent, effects);
    let e2 = this.composeWithEffects(completion.alternate, effects);
    return this.joinEffects(completion.joinCondition, e1, e2);
  }

  _collapseSimilarCompletions(joinCondition: AbstractValue, c1: Completion, c2: Completion): void | Completion {
    let realm = joinCondition.$Realm;
    let getAbstractValue = (v1: void | Value, v2: void | Value): Value => {
      if (v1 instanceof EmptyValue) return v2 || realm.intrinsics.undefined;
      if (v2 instanceof EmptyValue) return v1 || realm.intrinsics.undefined;
      return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
    };
    if (c1 instanceof BreakCompletion && c2 instanceof BreakCompletion && c1.target === c2.target) {
      let val = this.joinValues(realm, c1.value, c2.value, getAbstractValue);
      invariant(val instanceof Value);
      return new BreakCompletion(val, joinCondition.expressionLocation, c1.target);
    }
    if (c1 instanceof ContinueCompletion && c2 instanceof ContinueCompletion && c1.target === c2.target) {
      return new ContinueCompletion(realm.intrinsics.empty, joinCondition.expressionLocation, c1.target);
    }
    if (c1 instanceof ReturnCompletion && c2 instanceof ReturnCompletion) {
      let val = this.joinValues(realm, c1.value, c2.value, getAbstractValue);
      invariant(val instanceof Value);
      return new ReturnCompletion(val, joinCondition.expressionLocation);
    }
    if (c1 instanceof ThrowCompletion && c2 instanceof ThrowCompletion) {
      getAbstractValue = (v1: void | Value, v2: void | Value) => {
        return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
      };
      let val = this.joinValues(realm, c1.value, c2.value, getAbstractValue);
      invariant(val instanceof Value);
      return new ThrowCompletion(val, c1.location);
    }
    if (c1 instanceof SimpleNormalCompletion && c2 instanceof SimpleNormalCompletion) {
      return new SimpleNormalCompletion(getAbstractValue(c1.value, c2.value));
    }
    return undefined;
  }

  joinCompletions(joinCondition: Value, c1: Completion, c2: Completion): Completion {
    if (!joinCondition.mightNotBeTrue()) return c1;
    if (!joinCondition.mightNotBeFalse()) return c2;
    invariant(joinCondition instanceof AbstractValue);

    let c = this._collapseSimilarCompletions(joinCondition, c1, c2);
    if (c === undefined) {
      if (c1 instanceof AbruptCompletion && c2 instanceof AbruptCompletion)
        c = new JoinedAbruptCompletions(joinCondition, c1, c2);
      else {
        invariant(c1 instanceof AbruptCompletion || c1 instanceof NormalCompletion);
        invariant(c2 instanceof AbruptCompletion || c2 instanceof NormalCompletion);
        c = new JoinedNormalAndAbruptCompletions(joinCondition, c1, c2);
      }
    }
    return c;
  }

  joinEffects(joinCondition: Value, e1: Effects, e2: Effects): Effects {
    invariant(e1.canBeApplied);
    invariant(e2.canBeApplied);
    if (!joinCondition.mightNotBeTrue()) return e1;
    if (!joinCondition.mightNotBeFalse()) return e2;
    invariant(joinCondition instanceof AbstractValue);

    let {
      result: c1,
      generator: generator1,
      modifiedBindings: modifiedBindings1,
      modifiedProperties: modifiedProperties1,
      createdObjects: createdObjects1,
    } = e1;

    let {
      result: c2,
      generator: generator2,
      modifiedBindings: modifiedBindings2,
      modifiedProperties: modifiedProperties2,
      createdObjects: createdObjects2,
    } = e2;

    let realm = joinCondition.$Realm;

    let c = this.joinCompletions(joinCondition, c1, c2);

    let [modifiedGenerator1, modifiedGenerator2, bindings] = this._joinBindings(
      joinCondition,
      generator1,
      modifiedBindings1,
      generator2,
      modifiedBindings2
    );

    let generator = joinGenerators(joinCondition, modifiedGenerator1, modifiedGenerator2);

    let properties = this.joinPropertyBindings(
      realm,
      joinCondition,
      modifiedProperties1,
      modifiedProperties2,
      createdObjects1,
      createdObjects2
    );
    let createdObjects = new Set();
    createdObjects1.forEach(o => {
      createdObjects.add(o);
    });
    createdObjects2.forEach(o => {
      createdObjects.add(o);
    });

    return new Effects(c, generator, bindings, properties, createdObjects);
  }

  joinValuesOfSelectedCompletions(selector: Completion => boolean, completion: Completion): Value {
    let realm = completion.value.$Realm;
    if (completion instanceof JoinedAbruptCompletions || completion instanceof JoinedNormalAndAbruptCompletions) {
      let joinCondition = completion.joinCondition;
      let c = this.joinValuesOfSelectedCompletions(selector, completion.consequent);
      let a = this.joinValuesOfSelectedCompletions(selector, completion.alternate);
      let getAbstractValue = (v1: void | Value, v2: void | Value): Value => {
        return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
      };
      let jv = this.joinValues(realm, c, a, getAbstractValue);
      invariant(jv instanceof Value);
      if (completion instanceof JoinedNormalAndAbruptCompletions && completion.composedWith !== undefined) {
        let composedWith = completion.composedWith;
        let cjv = this.joinValuesOfSelectedCompletions(selector, composedWith);
        joinCondition = AbstractValue.createJoinConditionForSelectedCompletions(selector, composedWith);
        jv = this.joinValues(realm, jv, cjv, getAbstractValue);
        invariant(jv instanceof Value);
      }
      return jv;
    }
    if (selector(completion)) return completion.value;
    return realm.intrinsics.empty;
  }

  // Creates a single map that joins together maps m1 and m2 using the given join
  // operator. If an entry is present in one map but not the other, the missing
  // entry is treated as if it were there and its value were undefined.
  joinMaps<K, V>(m1: Map<K, V>, m2: Map<K, V>, join: (K, void | V, void | V) => V): Map<K, V> {
    let m3: Map<K, V> = new Map();
    m1.forEach((val1, key, map1) => {
      let val2 = m2.get(key);
      let val3 = join(key, val1, val2);
      m3.set(key, val3);
    });
    m2.forEach((val2, key, map2) => {
      if (!m1.has(key)) {
        m3.set(key, join(key, undefined, val2));
      }
    });
    return m3;
  }

  // Creates a single map that has an key, value pair for the union of the key
  // sets of m1 and m2. The value of a pair is the join of m1[key] and m2[key]
  // where the join is defined to be just m1[key] if m1[key] === m2[key] and
  // and abstract value with expression "joinCondition ? m1[key] : m2[key]" if not.
  _joinBindings(
    joinCondition: AbstractValue,
    g1: Generator,
    m1: Bindings,
    g2: Generator,
    m2: Bindings
  ): [Generator, Generator, Bindings] {
    let realm = joinCondition.$Realm;
    let getAbstractValue = (v1: void | Value, v2: void | Value) => {
      return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2, undefined, true, true);
    };
    let rewritten1 = false;
    let rewritten2 = false;
    let leak = (b: Binding, g: Generator, v: void | Value, rewritten: boolean) => {
      // just like to what happens in havocBinding, we are going to append a
      // binding-assignment generator entry; however, we play it safe and don't
      // mutate the generator; instead, we create a new one that wraps around the old one.
      if (!rewritten) {
        let h = new Generator(realm, "RewrittenToAppendBindingAssignments", g.pathConditions);
        if (!g.empty()) h.appendGenerator(g, "");
        g = h;
        rewritten = true;
      }
      if (v !== undefined && v !== realm.intrinsics.undefined) g.emitBindingAssignment(b, v);
      return [g, rewritten];
    };
    let join = (b: Binding, b1: void | BindingEntry, b2: void | BindingEntry) => {
      let l1 = b1 === undefined ? b.hasLeaked : b1.hasLeaked;
      let l2 = b2 === undefined ? b.hasLeaked : b2.hasLeaked;
      let v1 = b1 === undefined ? b.value : b1.value;
      let v2 = b2 === undefined ? b.value : b2.value;
      // ensure that if either none or both sides have leaked
      // note that if one side didn't have a binding entry yet, then there's nothing to actively leak
      if (!l1 && l2) [g1, rewritten1] = leak(b, g1, v1, rewritten1);
      else if (l1 && !l2) [g2, rewritten2] = leak(b, g2, v2, rewritten2);
      let hasLeaked = l1 || l2;
      // For leaked (and mutable) bindings, the actual value is no longer directly available.
      // In that case, we reset the value to undefined to prevent any use of the last known value.
      let value = hasLeaked ? undefined : this.joinValues(realm, v1, v2, getAbstractValue);
      invariant(value === undefined || value instanceof Value);
      return { hasLeaked, value };
    };
    let joinedBindings = this.joinMaps(m1, m2, join);
    return [g1, g2, joinedBindings];
  }

  // If v1 is known and defined and v1 === v2 return v1,
  // otherwise return getAbstractValue(v1, v2)
  joinValues(
    realm: Realm,
    v1: void | Value | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
    v2: void | Value | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }>,
    getAbstractValue: (void | Value, void | Value) => Value
  ): Value | Array<Value> | Array<{ $Key: void | Value, $Value: void | Value }> {
    if (Array.isArray(v1) || Array.isArray(v2)) {
      invariant(v1 === undefined || Array.isArray(v1));
      invariant(v2 === undefined || Array.isArray(v2));
      return joinArrays(realm, ((v1: any): void | Array<Value>), ((v2: any): void | Array<Value>), getAbstractValue);
    }
    invariant(v1 === undefined || v1 instanceof Value);
    invariant(v2 === undefined || v2 instanceof Value);
    if (
      v1 !== undefined &&
      v2 !== undefined &&
      !(v1 instanceof AbstractValue) &&
      !(v2 instanceof AbstractValue) &&
      StrictEqualityComparison(realm, v1.throwIfNotConcrete(), v2.throwIfNotConcrete())
    ) {
      return v1;
    } else {
      return getAbstractValue(v1, v2);
    }
  }

  joinPropertyBindings(
    realm: Realm,
    joinCondition: AbstractValue,
    m1: PropertyBindings,
    m2: PropertyBindings,
    c1: CreatedObjects,
    c2: CreatedObjects
  ): PropertyBindings {
    let join = (b: PropertyBinding, d1: void | Descriptor, d2: void | Descriptor) => {
      // If the PropertyBinding object has been freshly allocated do not join
      if (d1 === undefined) {
        if (c2.has(b.object)) return d2; // no join
        if (b.descriptor !== undefined && m1.has(b)) {
          // property was deleted
          d1 = cloneDescriptor(b.descriptor);
          invariant(d1 !== undefined);
          d1.value = realm.intrinsics.empty;
        } else {
          // no write to property
          d1 = b.descriptor; //Get value of property before the split
        }
      }
      if (d2 === undefined) {
        if (c1.has(b.object)) return d1; // no join
        if (b.descriptor !== undefined && m2.has(b)) {
          // property was deleted
          d2 = cloneDescriptor(b.descriptor);
          invariant(d2 !== undefined);
          d2.value = realm.intrinsics.empty;
        } else {
          // no write to property
          d2 = b.descriptor; //Get value of property before the split
        }
      }
      return this.joinDescriptors(realm, joinCondition, d1, d2);
    };
    return this.joinMaps(m1, m2, join);
  }

  joinDescriptors(
    realm: Realm,
    joinCondition: AbstractValue,
    d1: void | Descriptor,
    d2: void | Descriptor
  ): void | Descriptor {
    let getAbstractValue = (v1: void | Value, v2: void | Value) => {
      return AbstractValue.createFromConditionalOp(realm, joinCondition, v1, v2);
    };
    let clone_with_abstract_value = (d: Descriptor) => {
      invariant(d === d1 || d === d2);
      if (!IsDataDescriptor(realm, d)) {
        let d3: Descriptor = {};
        d3.joinCondition = joinCondition;
        return d3;
      }
      let dc = cloneDescriptor(d);
      invariant(dc !== undefined);
      let dcValue = dc.value;
      if (Array.isArray(dcValue)) {
        invariant(dcValue.length > 0);
        let elem0 = dcValue[0];
        if (elem0 instanceof Value) {
          dc.value = dcValue.map(e => {
            return d === d1
              ? getAbstractValue((e: any), realm.intrinsics.empty)
              : getAbstractValue(realm.intrinsics.empty, (e: any));
          });
        } else {
          dc.value = dcValue.map(e => {
            let { $Key: key1, $Value: val1 } = (e: any);
            let key3 =
              d === d1
                ? getAbstractValue(key1, realm.intrinsics.empty)
                : getAbstractValue(realm.intrinsics.empty, key1);
            let val3 =
              d === d1
                ? getAbstractValue(val1, realm.intrinsics.empty)
                : getAbstractValue(realm.intrinsics.empty, val1);
            return { $Key: key3, $Value: val3 };
          });
        }
      } else {
        invariant(dcValue === undefined || dcValue instanceof Value);
        dc.value =
          d === d1
            ? getAbstractValue(dcValue, realm.intrinsics.empty)
            : getAbstractValue(realm.intrinsics.empty, dcValue);
      }
      return dc;
    };
    if (d1 === undefined) {
      if (d2 === undefined) return undefined;
      // d2 is a new property created in only one branch, join with empty
      let d3 = clone_with_abstract_value(d2);
      if (!IsDataDescriptor(realm, d2)) d3.descriptor2 = d2;
      return d3;
    } else if (d2 === undefined) {
      invariant(d1 !== undefined);
      // d1 is a new property created in only one branch, join with empty
      let d3 = clone_with_abstract_value(d1);
      if (!IsDataDescriptor(realm, d1)) d3.descriptor1 = d1;
      return d3;
    } else {
      if (equalDescriptors(d1, d2) && IsDataDescriptor(realm, d1)) {
        let dc = cloneDescriptor(d1);
        invariant(dc !== undefined);
        dc.value = this.joinValues(realm, d1.value, d2.value, getAbstractValue);
        return dc;
      }
      let d3: Descriptor = {};
      d3.joinCondition = joinCondition;
      d3.descriptor1 = d1;
      d3.descriptor2 = d2;
      return d3;
    }
  }

  mapAndJoin(
    realm: Realm,
    values: Set<ConcreteValue>,
    joinConditionFactory: ConcreteValue => Value,
    functionToMap: ConcreteValue => Completion | Value
  ): Value {
    invariant(values.size > 1);
    let joinedEffects;
    for (let val of values) {
      let condition = joinConditionFactory(val);
      let effects = realm.evaluateForEffects(
        () => {
          invariant(condition instanceof AbstractValue);
          return Path.withCondition(condition, () => {
            return functionToMap(val);
          });
        },
        undefined,
        "mapAndJoin"
      );
      joinedEffects = joinedEffects === undefined ? effects : this.joinEffects(condition, effects, joinedEffects);
    }
    invariant(joinedEffects !== undefined);
    realm.applyEffects(joinedEffects);
    return realm.returnOrThrowCompletion(joinedEffects.result);
  }
}
