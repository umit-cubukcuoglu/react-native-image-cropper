import { useState, useEffect, createContext, useRef, RefObject } from "react";
import { LayoutChangeEvent, LayoutRectangle, Image, ImageStyle, ViewStyle } from "react-native";
import Animated, {
    useAnimatedRef,
    useAnimatedGestureHandler,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
    withSpring,
    runOnJS,
    runOnUI,
    measure,
} from "react-native-reanimated";
import {
    PanGestureHandlerGestureEvent,
    PinchGestureHandlerGestureEvent,
    TapGestureHandlerGestureEvent,
    State,
    HandlerStateChangeEvent,
    TapGestureHandlerEventPayload,
    GestureEventPayload,
} from "react-native-gesture-handler";
import ImageEditor from "@react-native-community/image-editor";
import { IFrameImperativeHandle } from "react-native-frame";

import {
    IImageCropperPinchGestureContext,
    IImageCropperPanGestureContext,
    IImageCropperHook,
    IImageCropperContext,
    IImageCropperImageStatus,
    IImageCropperCropImageResolve,
    IImageCropperMeasure,
    IImageCropperStatements,
    IImageCropperImageError
} from "./types";
import {
    DEFAULT_IMAGE_STATE,
    DEFAULT_MODE,
    DEFAULT_STATEMENTS
} from "./constants";

export const Context = createContext<IImageCropperContext>({} as IImageCropperContext)

const useHook = ({ props }: IImageCropperHook) => {
    const { mode = DEFAULT_MODE, uri, frame, onChangeState } = props;

    const containerRef = useAnimatedRef<Animated.View>();
    const imageRef = useAnimatedRef<Animated.Image>();
    const frameContainerRef = useAnimatedRef<Animated.View>();
    const frameRef = useRef<IFrameImperativeHandle>({} as IFrameImperativeHandle);

    const scale = useSharedValue(1);
    const translateY = useSharedValue(0);
    const translateX = useSharedValue(0);

    const frameContainerWidth = useSharedValue<number>(0);
    const frameContainerHeight = useSharedValue<number>(0);

    const containerLayout = useSharedValue<LayoutRectangle>({ width: 0, height: 0, x: 0, y: 0 });
    const imageLayout = useSharedValue<LayoutRectangle>({ width: 0, height: 0, x: 0, y: 0 });

    const [imageStatus, setImageStatus] = useState<IImageCropperImageStatus>(DEFAULT_IMAGE_STATE);
    const [imageRatio, setImageRatio] = useState<number>(0);
    const [isDoubleZooming, setIsDoubleZooming] = useState(false);

    const statements = useRef<IImageCropperStatements>(DEFAULT_STATEMENTS);

    const containerRatio = containerLayout.value.width / containerLayout.value.height;

    const minScale = 1;
    const maxScale = 4;

    useEffect(() => {
        getImageRatio();
    }, [uri]);

    useEffect(() => {
        changeStatements?.({ image: imageStatus });
    }, [
        JSON.stringify(imageStatus),
    ]);

    useEffect(() => {
        changeStatements?.({ isDoubleZooming });
    }, [
        isDoubleZooming,
    ]);

    const changeStatements = (params: IImageCropperStatements) => {
        const paramsIsNotExists = Object.keys(params).some((k) => (params as any)[k] !== (statements.current as any)[k]);

        if (!paramsIsNotExists) return;

        statements.current = { ...statements.current, ...params };

        onChangeState?.({ ...params, state: statements.current });
    }

    const getImageRatio = async () => {
        const { width, height, error } = await getImageSize(uri);

        if (error) return onImageError(error);

        width && height && setImageRatio(width / height);
    }

    const getLimits = (scale: number) => {
        const limitScale = Math.min(Math.max(scale, minScale), maxScale);
        const limitOffsetX = containerLayout.value.width * (limitScale - minScale) / 2 / limitScale - (containerLayout.value.width - imageLayout.value.width) / 2;
        const limitOffsetY = containerLayout.value.height * (limitScale - minScale) / 2 / limitScale - (containerLayout.value.height - imageLayout.value.height) / 2;

        return {
            limitScale,
            limitOffsetX,
            limitOffsetY
        };
    }

    const getMeasure = (ref: RefObject<any>): Promise<IImageCropperMeasure> => new Promise((resolve) => {
        runOnUI(async () => {
            "worklet";

            runOnJS(resolve)(measure(ref));
        })();
    });

    const getImageSize = (uri: string): Promise<{ width?: number, height?: number, error?: any }> => new Promise((resolve) => {
        Image.getSize(
            uri,
            (width, height) => {
                resolve({ width, height })
            },
            (error) => {
                resolve({ error })
            }
        );
    })

    const cropImage = (): IImageCropperCropImageResolve => new Promise(async (resolve) => {
        const { width, height, error } = await getImageSize(uri);

        if (!width || !height) return resolve({ error: "The dimensions of the uploaded image could not be calculated" });

        if (error) return resolve({ error });

        const containerMeasure = await getMeasure(containerRef);
        const imageMeasure = handleImageMeasure(await getMeasure(imageRef));

        const horizontalRatio = width / imageMeasure.width;
        const verticalRatio = height / imageMeasure.height;

        let imageUrl = await ImageEditor.cropImage(uri,
            {
                offset: {
                    x: horizontalRatio * Math.max(containerMeasure.pageX - imageMeasure.pageX, 0),
                    y: verticalRatio * Math.max(containerMeasure.pageY - imageMeasure.pageY, 0),
                },
                size: {
                    width: horizontalRatio * Math.min(containerMeasure.width, imageMeasure.width),
                    height: verticalRatio * Math.min(containerMeasure.height, imageMeasure.height)
                }
            }
        )

        if (!frame) return resolve({ uri: imageUrl });

        imageUrl = await ImageEditor.cropImage(imageUrl,
            {
                offset: {
                    x: horizontalRatio * frameRef.current.left.value,
                    y: verticalRatio * frameRef.current.top.value,
                },
                size: {
                    width: horizontalRatio * frameRef.current.width.value,
                    height: verticalRatio * frameRef.current.height.value,
                }
            }
        )

        return resolve({ uri: imageUrl });
    });

    const onFixScaleAndTranslate = () => {
        if (!Object.keys(containerLayout.value).length || !Object.keys(imageLayout.value).length) return;

        const { limitScale, limitOffsetX, limitOffsetY } = getLimits(scale.value);

        const limitTranslateX = (mode === "center" && imageLayout.value.width * limitScale <= containerLayout.value.width) ?
            0 :
            Math.max(Math.min(limitOffsetX, translateX.value), -limitOffsetX);
        const limitTranslateY = (mode === "center" && imageLayout.value.height * limitScale <= containerLayout.value.height) ?
            0 :
            Math.max(Math.min(limitOffsetY, translateY.value), -limitOffsetY);

        scale.value = withSpring(limitScale);
        translateX.value = withSpring(limitTranslateX);
        translateY.value = withSpring(limitTranslateY);

        fixFrameContainer(limitScale);
    }


    const onFixDoubleTap = (event: Readonly<GestureEventPayload & TapGestureHandlerEventPayload>) => {
        const isMaxScale = scale.value === maxScale;

        const { limitScale, limitOffsetX, limitOffsetY } = getLimits(scale.value * 2);

        const newScale = isMaxScale ? 1 : limitScale;

        const isImageWidthSmaller = newScale * imageLayout.value.width < containerLayout.value.width;
        const isImageHeightSmaller = newScale * imageLayout.value.height < containerLayout.value.height;

        const newTranslateX = ((imageLayout.value.width / 2 - event.x + translateX.value) * (newScale - scale.value)) / newScale;
        const newTranslateY = ((imageLayout.value.height / 2 - event.y + translateY.value) * (newScale - scale.value)) / newScale;

        const limitTranslateX = (isMaxScale || isImageWidthSmaller) ? 0 : Math.max(Math.min(limitOffsetX, newTranslateX), -limitOffsetX);
        const limitTranslateY = (isMaxScale || isImageHeightSmaller) ? 0 : Math.max(Math.min(limitOffsetY, newTranslateY), -limitOffsetY);

        runOnJS(setIsDoubleZooming)(true);

        scale.value = withTiming(newScale);
        translateX.value = withTiming(limitTranslateX);
        translateY.value = withTiming(limitTranslateY, {}, (finished) => {
            finished && runOnJS(setIsDoubleZooming)(false);
        });

        fixFrameContainer(newScale);
    }

    const onTapGestureEvent = useAnimatedGestureHandler<TapGestureHandlerGestureEvent>({
        onEnd: (event) => runOnJS(onFixDoubleTap)(event)
    });

    const onPinchGestureEvent = useAnimatedGestureHandler<PinchGestureHandlerGestureEvent, IImageCropperPinchGestureContext>({
        onStart: (event, context) => {
            context.scale = scale.value;
            context.lastScale = 1;
        },
        onActive: (event, context) => {
            const offsetX = event.focalX - (imageLayout.value.width / 2);
            const offsetY = event.focalY - (imageLayout.value.height / 2);
            const offsetScale = context.lastScale - event.scale;

            translateX.value = translateX.value + (offsetScale * offsetX);
            translateY.value = translateY.value + (offsetScale * offsetY);
            scale.value = (context.scale * event.scale);

            context.lastScale = event.scale;
        },
        onEnd: () => runOnJS(onFixScaleAndTranslate)()
    });

    const onPanGestureEvent = useAnimatedGestureHandler<PanGestureHandlerGestureEvent, IImageCropperPanGestureContext>({
        onStart: (event, context) => {
            context.translateY = translateY.value;
            context.translateX = translateX.value;
            context.scale = scale.value;
        },
        onActive: (event, context) => {
            translateX.value = context.translateX + event.translationX / context.scale;
            translateY.value = context.translateY + event.translationY / context.scale;
        },
        onEnd: () => runOnJS(onFixScaleAndTranslate)()
    });

    const fixFrameContainer = (scale: number) => {
        if (!frame || !Object.keys(frameRef.current).length) return;

        const oldFrameContainerWidth = frameContainerWidth?.value ?? imageLayout.value.width;
        const oldFrameContainerHeight = frameContainerHeight?.value ?? imageLayout.value.height;

        const newFrameContainerWidth = Math.min(containerLayout.value.width, imageLayout.value.width * scale);
        const newFrameContainerHeight = Math.min(containerLayout.value.height, imageLayout.value.height * scale);

        const frameLeft = frameRef.current.left.value + (newFrameContainerWidth - oldFrameContainerWidth) / 2;
        const limitFrameLeft = Math.max(Math.min(newFrameContainerWidth - frameRef.current.width.value, frameLeft), 0);
        const frameTop = frameRef.current.top.value + (newFrameContainerHeight - oldFrameContainerHeight) / 2;
        const limitFrameTop = Math.max(Math.min(newFrameContainerHeight - frameRef.current.height.value, frameTop), 0);
        const frameWidth = frameRef.current.width.value;
        const limitFrameWidth = Math.min(newFrameContainerWidth, frameWidth);
        const frameHeight = frameRef.current.height.value;
        const limitFrameHeight = Math.min(newFrameContainerHeight, frameHeight);

        const frameRatio = frameRef.current.width.value / frameRef.current.height.value;

        frameRef.current.width.value = withTiming(Math.min(limitFrameWidth, limitFrameHeight * frameRatio));
        frameRef.current.height.value = withTiming(Math.min(limitFrameHeight, limitFrameWidth / frameRatio));
        frameRef.current.top.value = withTiming(limitFrameTop + (oldFrameContainerHeight - newFrameContainerHeight) / 2, undefined, () => {
            frameContainerHeight.value = newFrameContainerHeight;
            frameRef.current.top.value = limitFrameTop;
        });
        frameRef.current.left.value = withTiming(limitFrameLeft + (oldFrameContainerWidth - newFrameContainerWidth) / 2, undefined, () => {
            frameContainerWidth.value = newFrameContainerWidth;
            frameRef.current.left.value = limitFrameLeft;
        });
    }

    const onContainerLayout = (event: LayoutChangeEvent) => {
        const layout = event.nativeEvent.layout;

        containerLayout.value = layout;
    }

    const handleImageMeasure = (measure: IImageCropperMeasure): IImageCropperMeasure => {
        const _imageRatio = measure.width / measure.height;

        const width = _imageRatio > imageRatio ? (measure.height * imageRatio) : measure.width;
        const height = _imageRatio > imageRatio ? measure.height : (measure.width / imageRatio);

        const offsetWidth = (measure.width - width) / 2;
        const offsetHeight = (measure.height - height) / 2;

        return {
            width,
            height,
            x: measure.x + offsetWidth,
            y: measure.y + offsetHeight,
            pageX: measure.pageX + offsetWidth,
            pageY: measure.pageY + offsetHeight,
        }
    }

    const onImageLayout = async (event: LayoutChangeEvent) => {
        const layout = handleImageMeasure({ ...event.nativeEvent.layout, pageX: 0, pageY: 0 });

        translateY.value = 0;
        translateX.value = 0;

        imageLayout.value = layout;

        frameContainerWidth.value = Math.min(layout.width * scale.value, containerLayout.value.width);
        frameContainerHeight.value = Math.min(layout.height * scale.value, containerLayout.value.height);
    }

    const onImageLoad = () => setImageStatus({ isLoaded: true, error: undefined });

    const onImageError = (event: IImageCropperImageError) => {
        setImageStatus({ isLoaded: false, error: event });

        console.warn("Could not load image");
    };

    const onPinchHandlerStateChange = ({ nativeEvent }: HandlerStateChangeEvent) => {
        const state = nativeEvent.state;

        (state === State.FAILED) && onFixScaleAndTranslate();

        changeStatements({ isZooming: state === State.ACTIVE ? true : false });
    }

    const onPanHandlerStateChange = ({ nativeEvent }: HandlerStateChangeEvent) => {
        const state = nativeEvent.state;

        changeStatements({ isDragging: state === State.ACTIVE ? true : false });
    }

    const canVisible = imageStatus?.isLoaded && imageRatio;

    const rWrapperStyle = useAnimatedStyle(() => ({
        opacity: withTiming(canVisible ? 1 : 0, { duration: 500 })
    }));

    const rImageStyle = useAnimatedStyle(() => {
        const style: ImageStyle = {
            transform: [
                { scale: scale.value },
                { translateX: translateX.value },
                { translateY: translateY.value },
            ]
        }

        if (!(imageRatio && Object.keys(containerLayout.value).length)) return style;

        if (mode === "center") {
            style.width = containerLayout.value.width;
            style.height = containerLayout.value.height;
            style.resizeMode = "contain";
        } else {
            style.width = imageRatio > containerRatio ?
                containerLayout.value.height * imageRatio :
                containerLayout.value.width;
            style.height = imageRatio > containerRatio ?
                containerLayout.value.height :
                containerLayout.value.width / imageRatio;
            style.aspectRatio = imageRatio;
        }

        return style;
    });

    const rFrameContainerStyle = useAnimatedStyle(() => {
        const style: ViewStyle = {};

        if (mode === "cover") {
            containerLayout.value.width && (style.width = containerLayout.value.width);
            containerLayout.value.height && (style.height = containerLayout.value.height);
        } else {
            frameContainerWidth.value && (style.width = frameContainerWidth.value);
            frameContainerHeight.value && (style.height = frameContainerHeight.value);
        }

        return style;
    });

    return {
        mainProps: props,
        containerRef,
        imageRef,
        frameRef,
        frameContainerRef,
        isDoubleZooming,
        imageRatio,
        imageStatus,
        canVisible,
        rWrapperStyle,
        rImageStyle,
        rFrameContainerStyle,
        cropImage,
        onContainerLayout,
        onImageLayout,
        onImageLoad,
        onImageError,
        onTapGestureEvent,
        onPinchGestureEvent,
        onPanGestureEvent,
        onPinchHandlerStateChange,
        onPanHandlerStateChange
    }
};

export default useHook;